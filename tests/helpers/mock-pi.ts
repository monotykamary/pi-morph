/**
 * Test helpers for pi-morph-plugin.
 *
 * Provides a mock ExtensionAPI and factories for building test contexts.
 */

import type { ExtensionAPI, ToolInfo } from '@earendil-works/pi-coding-agent';

// ---------------------------------------------------------------------------
// Mock ExtensionAPI
// ---------------------------------------------------------------------------

export interface MockPiOptions {
  /** Pre-populated tools returned by getAllTools(). */
  tools?: ToolInfo[];
  /** Pre-populated active tool names returned by getActiveTools(). */
  activeTools?: string[];
}

export interface MockPi extends ExtensionAPI {
  // Tracked state for assertions
  _toolRegistry: ToolInfo[];
  _activeTools: Set<string>;
  _registeredTools: string[];
  _eventHandlers: Map<string, Array<(...args: any[]) => void>>;
  _commandHandlers: Array<{ name: string; config: any }>;
}

const DEFAULT_BUILTIN_TOOLS: ToolInfo[] = [
  {
    name: 'bash',
    description: 'Execute a bash command',
    parameters: {} as any,
    sourceInfo: {
      path: '<builtin:bash>',
      source: 'builtin',
      scope: 'temporary',
      origin: 'top-level',
    },
  },
  {
    name: 'read',
    description: 'Read file contents',
    parameters: {} as any,
    sourceInfo: {
      path: '<builtin:read>',
      source: 'builtin',
      scope: 'temporary',
      origin: 'top-level',
    },
  },
  {
    name: 'edit',
    description: 'Edit a file',
    parameters: {} as any,
    sourceInfo: {
      path: '<builtin:edit>',
      source: 'builtin',
      scope: 'temporary',
      origin: 'top-level',
    },
  },
  {
    name: 'write',
    description: 'Write a file',
    parameters: {} as any,
    sourceInfo: {
      path: '<builtin:write>',
      source: 'builtin',
      scope: 'temporary',
      origin: 'top-level',
    },
  },
];

const noop = () => {};

export function createMockPi(opts: MockPiOptions = {}): MockPi {
  const toolRegistry: ToolInfo[] = [...(opts.tools ?? DEFAULT_BUILTIN_TOOLS)];
  const activeTools = new Set<string>(opts.activeTools ?? toolRegistry.map((t) => t.name));
  const eventHandlers = new Map<string, Array<(...args: any[]) => void>>();
  const commandHandlers: Array<{ name: string; config: any }> = [];

  const mock: MockPi = {
    _toolRegistry: toolRegistry,
    _activeTools: activeTools,
    _registeredTools: [],
    _eventHandlers: eventHandlers,
    _commandHandlers: commandHandlers,

    getAllTools(): ToolInfo[] {
      return [...toolRegistry];
    },
    getActiveTools(): string[] {
      return [...activeTools];
    },
    setActiveTools(toolNames: string[]): void {
      activeTools.clear();
      for (const name of toolNames) activeTools.add(name);
    },
    registerTool(tool: any): void {
      mock._registeredTools.push(tool.name);
      if (!toolRegistry.some((t) => t.name === tool.name)) {
        toolRegistry.push({
          name: tool.name,
          description: tool.description ?? '',
          parameters: tool.parameters ?? ({} as any),
          sourceInfo: {
            path: '<mock>',
            source: 'extension',
            scope: 'temporary',
            origin: 'top-level',
          },
        });
        activeTools.add(tool.name);
      }
    },
    on(event: string, handler: any) {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event)!.push(handler);
    },
    registerCommand(name: string, config: any) {
      commandHandlers.push({ name, config });
    },
    getCommands(): any[] {
      return commandHandlers.map((c) => ({ name: c.name, ...c.config }));
    },
    registerShortcut: noop as any,
    registerFlag: noop as any,
    getFlag: noop as any,
    registerMessageRenderer: noop as any,
    sendMessage: noop as any,
    sendUserMessage: noop as any,
    appendEntry: noop as any,
    setSessionName: noop as any,
    getSessionName: noop as any,
    setLabel: noop as any,
    exec: noop as any,
    setModel: noop as any,
    getThinkingLevel: noop as any,
    setThinkingLevel: noop as any,
    registerProvider: noop as any,
    unregisterProvider: noop as any,
    events: {} as any,
  } as MockPi;

  return mock;
}

export function makeCtx(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    cwd: '/fake/project',
    hasUI: true,
    ui: {
      notify: noop,
      setStatus: noop,
      theme: { fg: (_k: string, v: any) => v },
    },
    ...overrides,
  };
}

/** Get first handler registered for an event, or undefined */
export function getHandler(pi: MockPi, event: string): ((...args: any[]) => void) | undefined {
  return pi._eventHandlers.get(event)?.[0];
}
