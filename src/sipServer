import { 
  UserAgent, 
  UserAgentOptions, 
  Registerer,
  Inviter,
  SessionState,
  URI
} from "sip.js";

interface CallSession {
  callId: string;
  inviter?: Inviter;
  state: string;
  startTime: Date;
  toNumber: string;
}

export class SIPServer {
  private userAgent: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private activeCalls: Map<string, CallSession> = new Map();

  constructor(
    private yeasterHost: string,
    private yeasterPort: number,
    private sipUsername: string,
    private sipPassword: string,
    private yeasterDomain: string
  ) {}

  async connect(): Promise<string> {
    try {
      // Use WSS (WebSocket Secure) via ngrok tunnel for real connections
      const wsURL = `wss://yeaster:${this.yeasterPort}/ws`;

      const options: UserAgentOptions = {
        loggerFactory: undefined, // Disable logging for production
        transportOptions: {
          wsServers: [wsURL],
          traceSip: false
        },
        uri: new URI("sip", this.sipUsername, this.yeasterDomain),
        authorizationPassword: this.sipPassword,
        displayName: "Novelty Call Center",
        register: false
      };

      this.userAgent = new UserAgent(options);

      // Register transport
      this.userAgent.transport.onConnect = () => {
        console.log("[SIP] ✅ Transport connected");
        this.register();
      };

      this.userAgent.transport.onDisconnect = () => {
        console.log("[SIP] ⚠️  Transport disconnected");
      };

      await this.userAgent.transport.connect();

      return "SIP transport connected";
    } catch (error) {
      console.error("[SIP] ❌ Connection failed:", error);
      throw error;
    }
  }

  private async register(): Promise<void> {
    if (!this.userAgent) return;

    try {
      this.registerer = new Registerer(this.userAgent);
      await this.registerer.register();
      console.log(`[SIP] ✅ Registered as ${this.sipUsername}`);
    } catch (error) {
      console.error("[SIP] ❌ Registration failed:", error);
    }
  }

  async makeCall(toNumber: string, callId: string): Promise<{ success: boolean; message: string }> {
    if (!this.userAgent) {
      return { success: false, message: "SIP not connected" };
    }

    try {
      const targetURI = new URI("sip", toNumber, this.yeasterDomain);
      const inviter = new Inviter(this.userAgent, targetURI);

      const session: CallSession = {
        callId,
        inviter,
        state: "calling",
        startTime: new Date(),
        toNumber
      };

      this.activeCalls.set(callId, session);

      inviter.stateChange.addListener((newState: SessionState) => {
        console.log(`[Call ${callId}] State: ${newState}`);
        session.state = newState;

        if (newState === SessionState.Established) {
          console.log(`[Call ${callId}] ✅ Connected`);
        } else if (newState === SessionState.Terminated) {
          console.log(`[Call ${callId}] ✅ Ended`);
          this.activeCalls.delete(callId);
        }
      });

      await inviter.invite();
      return { success: true, message: "Call initiated" };
    } catch (error) {
      console.error(`[Call ${callId}] ❌ Error:`, error);
      this.activeCalls.delete(callId);
      return { success: false, message: String(error) };
    }
  }

  async endCall(callId: string): Promise<{ success: boolean; message: string }> {
    const session = this.activeCalls.get(callId);
    if (!session || !session.inviter) {
      return { success: false, message: "Call not found" };
    }

    try {
      await session.inviter.bye();
      this.activeCalls.delete(callId);
      return { success: true, message: "Call ended" };
    } catch (error) {
      console.error(`[Call ${callId}] ❌ End failed:`, error);
      return { success: false, message: String(error) };
    }
  }

  getCallStatus(callId: string): { state: string; duration: number } | null {
    const session = this.activeCalls.get(callId);
    if (!session) return null;

    const duration = Math.floor(
      (new Date().getTime() - session.startTime.getTime()) / 1000
    );
    return { state: session.state, duration };
  }

  async disconnect(): Promise<void> {
    if (this.userAgent) {
      await this.userAgent.transport.disconnect();
      console.log("[SIP] ✅ Disconnected");
    }
  }
}

