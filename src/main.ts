/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import './polyfill.js';

import process from 'node:process';

import type {Channel} from './browser.js';
import {closeBrowser, ensureBrowserConnected, ensureBrowserLaunched} from './browser.js';
import {cliOptions, parseArguments} from './cli.js';
import {loadIssueDescriptions} from './issue-descriptions.js';
import {logger, saveLogsToFile} from './logger.js';
import {McpContext} from './McpContext.js';
import {McpResponse} from './McpResponse.js';
import {Mutex} from './Mutex.js';
import {ClearcutLogger} from './telemetry/ClearcutLogger.js';
import {computeFlagUsage} from './telemetry/flagUtils.js';
import {bucketizeLatency} from './telemetry/metricUtils.js';
import {
  McpServer,
  StdioServerTransport,
  type CallToolResult,
  SetLevelRequestSchema,
} from './third_party/index.js';
import {ToolCategory} from './tools/categories.js';
import type {ToolDefinition} from './tools/ToolDefinition.js';
import {tools} from './tools/tools.js';

// If moved update release-please config
// x-release-please-start-version
const VERSION = '0.17.4';
// x-release-please-end

export const args = parseArguments(VERSION);

const logFile = args.logFile ? saveLogsToFile(args.logFile) : undefined;
if (
  process.env['CI'] ||
  process.env['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS']
) {
  console.error(
    "turning off usage statistics. process.env['CI'] || process.env['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS'] is set.",
  );
  args.usageStatistics = false;
}

let clearcutLogger: ClearcutLogger | undefined;
if (args.usageStatistics) {
  clearcutLogger = new ClearcutLogger({
    logFile: args.logFile,
    appVersion: VERSION,
    clearcutEndpoint: args.clearcutEndpoint,
    clearcutForceFlushIntervalMs: args.clearcutForceFlushIntervalMs,
    clearcutIncludePidHeader: args.clearcutIncludePidHeader,
  });
}

process.on('unhandledRejection', (reason, promise) => {
  logger('Unhandled promise rejection', promise, reason);
});

logger(`Starting Chrome DevTools MCP Server v${VERSION}`);
const server = new McpServer(
  {
    name: 'chrome_devtools',
    title: 'Chrome DevTools MCP server',
    version: VERSION,
  },
  {capabilities: {logging: {}}},
);
server.server.setRequestHandler(SetLevelRequestSchema, () => {
  return {};
});

let context: McpContext;
async function getContext(): Promise<McpContext> {
  const chromeArgs: string[] = [
    ...(args.chromeArg ?? []).map(String),
    ...((args.chromeArgs as string[] | undefined) ?? []).map(String),
  ];
  const ignoreDefaultChromeArgs: string[] = (
    args.ignoreDefaultChromeArg ?? []
  ).map(String);
  if (args.proxyServer) {
    chromeArgs.push(`--proxy-server=${args.proxyServer}`);
  }
  const devtools = args.experimentalDevtools ?? false;
  const browser =
    args.browserUrl || args.wsEndpoint || args.autoConnect
      ? await ensureBrowserConnected({
          browserURL: args.browserUrl,
          wsEndpoint: args.wsEndpoint,
          wsHeaders: args.wsHeaders,
          // Important: only pass channel, if autoConnect is true.
          channel: args.autoConnect ? (args.channel as Channel) : undefined,
          userDataDir: args.userDataDir,
          devtools,
        })
      : await ensureBrowserLaunched({
          headless: args.headless,
          executablePath: args.executablePath,
          channel: args.channel as Channel,
          isolated: args.isolated ?? false,
          userDataDir: args.userDataDir,
          logFile,
          viewport: args.viewport,
          chromeArgs,
          ignoreDefaultChromeArgs,
          acceptInsecureCerts: args.acceptInsecureCerts,
          devtools,
          stealth: args.stealth,
          enableExtensions: args.categoryExtensions,
        });

  if (context?.browser !== browser) {
    // Stop the old reaper before creating a new context.
    context?.stopIdlePageReaper();
    context = await McpContext.from(browser, logger, {
      experimentalDevToolsDebugging: devtools,
      experimentalIncludeAllPages: args.experimentalIncludeAllPages,
      performanceCrux: args.performanceCrux,
    });
    // Start idle page reaper: closes pages idle for 5+ minutes.
    // When all pages are closed, kill the browser entirely.
    // On the next tool call, getContext() will relaunch transparently.
    context.startIdlePageReaper(() => {
      logger('Idle reaper: all pages closed, shutting down browser');
      void closeBrowser();
    });
  }
  return context;
}

const logDisclaimers = () => {
  console.error(
    `chrome-devtools-mcp exposes content of the browser instance to the MCP clients allowing them to inspect,
debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.`,
  );

  if (args.performanceCrux) {
    console.error(
      `Performance tools may send trace URLs to the Google CrUX API to fetch real-user experience data. To disable, run with --no-performance-crux.`,
    );
  }

  if (args.usageStatistics) {
    console.error(
      `
Google collects usage statistics to improve Chrome DevTools MCP. To opt-out, run with --no-usage-statistics.
For more details, visit: https://github.com/ChromeDevTools/chrome-devtools-mcp#usage-statistics`,
    );
  }
};

const toolMutex = new Mutex();

function registerTool(tool: ToolDefinition): void {
  if (
    tool.annotations.category === ToolCategory.EMULATION &&
    args.categoryEmulation === false
  ) {
    return;
  }
  if (
    tool.annotations.category === ToolCategory.PERFORMANCE &&
    args.categoryPerformance === false
  ) {
    return;
  }
  if (
    tool.annotations.category === ToolCategory.NETWORK &&
    args.categoryNetwork === false
  ) {
    return;
  }
  if (
    tool.annotations.category === ToolCategory.EXTENSIONS &&
    args.categoryExtensions === false
  ) {
    return;
  }
  if (
    tool.annotations.conditions?.includes('computerVision') &&
    !args.experimentalVision
  ) {
    return;
  }
  if (
    tool.annotations.conditions?.includes('experimentalInteropTools') &&
    !args.experimentalInteropTools
  ) {
    return;
  }
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.schema,
      annotations: tool.annotations,
    },
    async (params): Promise<CallToolResult> => {
      const guard = await toolMutex.acquire();
      const startTime = Date.now();
      let success = false;
      try {
        logger(`${tool.name} request: ${JSON.stringify(params, null, '  ')}`);
        const context = await getContext();
        logger(`${tool.name} context: resolved`);
        // Mark the selected page as active to prevent idle reaper from closing it.
        try {
          context.touchPage(context.getSelectedPage());
        } catch {
          // No page selected yet — that's fine.
        }
        await context.detectOpenDevToolsWindows();
        const response = new McpResponse();
        await tool.handler(
          {
            params,
          },
          response,
          context,
        );
        const {content, structuredContent} = await response.handle(
          tool.name,
          context,
        );
        const result: CallToolResult & {
          structuredContent?: Record<string, unknown>;
        } = {
          content,
        };
        success = true;
        if (args.experimentalStructuredContent) {
          result.structuredContent = structuredContent as Record<
            string,
            unknown
          >;
        }
        return result;
      } catch (err) {
        logger(`${tool.name} error:`, err, err?.stack);
        let errorText = err && 'message' in err ? err.message : String(err);
        if ('cause' in err && err.cause) {
          errorText += `\nCause: ${err.cause.message}`;
        }
        return {
          content: [
            {
              type: 'text',
              text: errorText,
            },
          ],
          isError: true,
        };
      } finally {
        void clearcutLogger?.logToolInvocation({
          toolName: tool.name,
          success,
          latencyMs: bucketizeLatency(Date.now() - startTime),
        });
        guard.dispose();
      }
    },
  );
}

for (const tool of tools) {
  registerTool(tool);
}

await loadIssueDescriptions();
const transport = new StdioServerTransport();
await server.connect(transport);
logger('Chrome DevTools MCP Server connected');

// Graceful shutdown: kill Chrome when the MCP server exits for any reason.
let shuttingDown = false;
async function gracefulShutdown(reason: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger(`Shutting down: ${reason}`);
  try {
    context?.dispose();
  } catch {
    // best-effort
  }
  try {
    await closeBrowser();
  } catch {
    // best-effort
  }
  logger('Shutdown complete');
  process.exit(0);
}

// Handle OS signals (container stop, systemd, Ctrl+C)
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    void gracefulShutdown(`received ${signal}`);
  });
}

// Handle MCP client disconnect (transport/server close)
server.server.onclose = () => {
  void gracefulShutdown('MCP client disconnected');
};

// Handle stdin closing (parent process died)
process.stdin.on('close', () => {
  void gracefulShutdown('stdin closed');
});

logDisclaimers();
void clearcutLogger?.logDailyActiveIfNeeded();
void clearcutLogger?.logServerStart(computeFlagUsage(args, cliOptions));
