// Stub type declarations for omp runtime modules (development only).
// At runtime, omp injects the real ExtensionAPI.
declare module "@oh-my-pi/pi-coding-agent" {
	export interface ExtensionAPI {
		registerTool(def: ToolDefinition): void;
		registerCommand(name: string, def: CommandDefinition): void;
		on(event: string, handler: (...args: any[]) => void): void;
		appendEntry(type: string, data: unknown): void;
		sendUserMessage(message: string, options?: { deliverAs?: string }): void;
		sendMessage(message: string, options?: { deliverAs?: string; triggerTurn?: boolean }): void;
		typebox: {
			Type: {
				Object(schema: Record<string, any>): any;
				String(options?: any): any;
				Optional(schema: any): any;
			};
		};
		logger: {
			info(msg: string, data?: any): void;
			warn(msg: string, data?: any): void;
			error(msg: string, data?: any): void;
		};
		memory?: {
			save(key: string, data: unknown): Promise<void>;
			load(key: string): Promise<unknown>;
		};
	}
	interface ToolDefinition {
		name: string;
		label?: string;
		description: string;
		parameters: any;
		execute(
			toolCallId: any,
			params: any,
			signal: any,
			onUpdate: any,
			ctx: any,
		): Promise<{
			content: Array<{ type: string; text: string }>;
			isError?: boolean;
		}>;
	}
	interface CommandDefinition {
		description: string;
		handler: (args: any, ctx: ExtensionCommandContext) => Promise<void>;
	}
	interface ExtensionCommandContext {
		cwd: string;
		sessionManager?: {
			getBranch(): Array<{
				type: string;
				customType?: string;
				data?: unknown;
			}>;
		};
		ui: {
			notify(msg: string, level: "info" | "warning" | "error"): void;
			setStatus(key: string, msg: string): void;
			setWidget?(content: string[], options?: { placement?: "aboveEditor" | "belowEditor" }): void;
		};
	}
}
