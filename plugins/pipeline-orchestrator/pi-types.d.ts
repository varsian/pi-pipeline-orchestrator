// Stub type declarations for pi runtime modules.
// These modules are injected by pi at runtime; the stubs exist only to
// satisfy the LSP / TypeScript type-checker during development.
declare module "@earendil-works/pi-coding-agent" {
	export interface ExtensionAPI {
		registerTool(def: ToolDefinition): void;
		registerCommand(name: string, def: CommandDefinition): void;
		on(event: string, handler: (...args: any[]) => void): void;
		appendEntry(type: string, data: unknown): void;
		sendUserMessage(message: string, options?: { deliverAs?: string }): void;
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
			getEntries(): Array<{
				type: string;
				customType?: string;
				data?: unknown;
			}>;
		};
		ui: {
			notify(msg: string, level: "info" | "warning" | "error"): void;
			setStatus(key: string, msg: string): void;
		};
	}
}

declare module "typebox" {
	export const Type: {
		Object(schema: Record<string, any>): any;
		String(options?: any): any;
		Optional(schema: any): any;
	};
}
