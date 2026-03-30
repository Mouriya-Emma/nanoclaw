import {
  Channel,
  ModelPreference,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Optional lifecycle hooks (used by channels that support in-chat commands)
  onRegisterGroup?: (jid: string, group: RegisteredGroup) => void;
  onClearSession?: (jid: string) => void;
  onStopContainer?: (jid: string) => void;
  onSetModel?: (jid: string, provider: string, modelId?: string) => void;
  onGetModel?: (jid: string) => ModelPreference;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
