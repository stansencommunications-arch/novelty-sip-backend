// Import ws WebSocket before sip.js so we can pass it explicitly via transportOptions.
// DO NOT rely on a globalThis polyfill — sip.js captures the WebSocket constructor
// at module-load time, before any polyfill would run in Node.js.
import WebSocket from 'ws';

import {
  UserAgent,
  type UserAgentOptions,
  Registerer,
  Inviter,
  SessionState,
} from 'sip.js';
import { EventEmitter } from 'events';

interface CallSession {
  callId: string;
  inviter: Inviter;
  state: string;
  startTime: Date | null;
  toNumber: string;
}

// Minimal signaling-only SessionDescriptionHandler.
// The Yeastar PBX handles all media; this backend only drives SIP signaling.
function makeSignalingOnlySdh() {
  const minimalSdp = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=Novelty Backend',
    'c=IN IP4 0.0.0.0',
    't=0 0',
    'm=audio 0 RTP/AVP 0',
    'a=rtpmap:0 PCMU/8000',
    'a=inactive',
    '',
  ].join('\r\n');

  return {
    close: () => {},
    getDescription: () => Promise.resolve({ contentType: 'application/sdp', body: minimalSdp }),
    hasDescription: (ct: string) => ct === 'application/sdp',
    holdModifier: () => Promise.resolve(minimalSdp),
    rollbackDescription: () => Promise.resolve(),
    setDescription: () => Promise.resolve(),
    sendDtmf: () => false,
  };
}

export class SIPServer extends EventEmitter {
  private userAgent: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private activeCalls: Map<string, CallSession> = new Map();
  private sipReady = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private wsUrl: string,
    private sipUsername: string,
    private sipPassword: string,
    private yeasterDomain: string,
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    // Clean up any previous user agent before reconnecting
    if (this.userAgent) {
      try { await this.userAgent.stop(); } catch (_) {}
      this.userAgent = null;
      this.registerer = null;
    }

    const aor = `sip:${this.sipUsername}@${this.yeasterDomain}`;
    console.log(`[SIP] Connecting  AOR=${aor}  WS=${this.wsUrl}`);

    const options: UserAgentOptions = {
      uri: UserAgent.makeURI(aor) ?? undefined,
      transportOptions: {
        server: this.wsUrl,
        // Pass the ws package constructor explicitly so sip.js works in Node.js.
        // This is the correct approach — avoids globalThis polyfill timing issues.
        WebSocketConstructor: WebSocket as unknown as typeof globalThis.WebSocket,
      },
      authorizationUsername: this.sipUsername,
      authorizationPassword: this.sipPassword,
      displayName: 'Novelty Call Center',
      sessionDescriptionHandlerFactory:
        () => makeSignalingOnlySdh() as unknown as ReturnType<NonNullable<UserAgentOptions['sessionDescriptionHandlerFactory']>>,
      logBuiltinEnabled: true,
      logLevel: 'warn',
      delegate: {
        onConnect: () => {
          console.log('[SIP] ✅ Transport connected — registering...');
          this.sipReady = false;
          this.registerer = new Registerer(this.userAgent!);

          this.registerer.stateChange.addListener((state) => {
            if (state === 'Registered') {
              this.sipReady = true;
              console.log(`[SIP] ✅ Registered as ${this.sipUsername}`);
              this.emit('registered');
            } else if (state === 'Unregistered') {
              this.sipReady = false;
              console.warn('[SIP] Unregistered');
              this.emit('unregistered');
            }
          });

          this.registerer.register().catch((err) => {
            console.error('[SIP] Registration error:', err);
            this.emit('error', err);
          });

          this.emit('connected');
        },
        onDisconnect: (error?: Error) => {
          this.sipReady = false;
          console.warn('[SIP] ❌ Disconnected:', error?.message ?? 'no reason');
          this.emit('disconnected', error);
          // Auto-reconnect after 10 s unless explicitly stopped
          if (!this.stopped) {
            this.reconnectTimer = setTimeout(() => {
              console.log('[SIP] Attempting reconnect...');
              this.connect().catch((err) => console.error('[SIP] Reconnect failed:', err));
            }, 10_000);
          }
        },
      },
    };

    this.userAgent = new UserAgent(options);
    await this.userAgent.start();
    console.log('[SIP] UserAgent started');
  }

  async makeCall(
    toNumber: string,
    callId: string,
    onStateChange: (callId: string, state: string) => void,
  ): Promise<{ success: boolean; message: string }> {
    if (!this.userAgent || !this.sipReady) {
      return { success: false, message: 'SIP not ready' };
    }

    const targetUri = UserAgent.makeURI(`sip:${toNumber}@${this.yeasterDomain}`);
    if (!targetUri) return { success: false, message: `Invalid target: ${toNumber}` };

    console.log(`[Call ${callId}] Dialing ${toNumber}`);

    const inviter = new Inviter(this.userAgent, targetUri);
    const session: CallSession = {
      callId,
      inviter,
      state: 'calling',
      startTime: null,
      toNumber,
    };
    this.activeCalls.set(callId, session);

    inviter.stateChange.addListener((newState: SessionState) => {
      session.state = newState;
      console.log(`[Call ${callId}] → ${newState}`);

      switch (newState) {
        case SessionState.Establishing:
          onStateChange(callId, 'ringing');
          break;
        case SessionState.Established:
          session.startTime = new Date();
          onStateChange(callId, 'connected');
          break;
        case SessionState.Terminated:
          this.activeCalls.delete(callId);
          onStateChange(callId, 'idle');
          break;
      }
    });

    // Fire 'calling' before invite so UI updates immediately
    onStateChange(callId, 'calling');

    try {
      await inviter.invite();
      return { success: true, message: 'Call initiated' };
    } catch (err) {
      this.activeCalls.delete(callId);
      onStateChange(callId, 'idle');
      console.error(`[Call ${callId}] Invite failed:`, err);
      return { success: false, message: String(err) };
    }
  }

  async endCall(callId: string): Promise<{ success: boolean; message: string }> {
    const session = this.activeCalls.get(callId);
    if (!session) return { success: false, message: 'Call not found' };

    console.log(`[Call ${callId}] Ending (state=${session.inviter.state})`);
    try {
      if (session.inviter.state === SessionState.Established) {
        // Session.bye() is on the base class; cast through unknown to reach it safely
        await (session.inviter as unknown as { bye: () => Promise<void> }).bye();
      } else if (
        session.inviter.state === SessionState.Establishing ||
        session.inviter.state === SessionState.Initial
      ) {
        await session.inviter.cancel();
      }
    } catch (err) {
      console.error(`[Call ${callId}] End error (non-fatal):`, err);
    }
    this.activeCalls.delete(callId);
    return { success: true, message: 'Call ended' };
  }

  getCallStatus(callId: string): { state: string; duration: number } | null {
    const session = this.activeCalls.get(callId);
    if (!session) return null;
    const duration = session.startTime
      ? Math.floor((Date.now() - session.startTime.getTime()) / 1000)
      : 0;
    return { state: session.state, duration };
  }

  isReady(): boolean {
    return this.sipReady;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { await this.registerer?.unregister(); } catch (_) {}
    await this.userAgent?.stop();
    console.log('[SIP] Stopped');
  }
}
