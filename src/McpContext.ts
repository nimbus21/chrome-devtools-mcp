/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {TargetUniverse} from './DevtoolsUtils.js';
import {
  extractUrlLikeFromDevToolsTitle,
  UniverseManager,
  urlsEqual,
} from './DevtoolsUtils.js';
import type {ListenerMap, UncaughtError} from './PageCollector.js';
import {NetworkCollector, ConsoleCollector} from './PageCollector.js';
import {Locator} from './third_party/index.js';
import type {DevTools} from './third_party/index.js';
import type {
  Browser,
  ConsoleMessage,
  Debugger,
  Dialog,
  ElementHandle,
  HTTPRequest,
  Page,
  SerializedAXNode,
  PredefinedNetworkConditions,
  Viewport,
} from './third_party/index.js';
import {listPages} from './tools/pages.js';
import {takeSnapshot} from './tools/snapshot.js';
import {CLOSE_PAGE_ERROR} from './tools/ToolDefinition.js';
import type {Context, DevToolsData} from './tools/ToolDefinition.js';
import type {TraceResult} from './trace-processing/parse.js';
import {
  ExtensionRegistry,
  type InstalledExtension,
} from './utils/ExtensionRegistry.js';
import {WaitForHelper} from './WaitForHelper.js';

export interface TextSnapshotNode extends SerializedAXNode {
  id: string;
  backendNodeId?: number;
  loaderId?: string;
  children: TextSnapshotNode[];
}

export interface GeolocationOptions {
  latitude: number;
  longitude: number;
}

export interface TextSnapshot {
  root: TextSnapshotNode;
  idToNode: Map<string, TextSnapshotNode>;
  snapshotId: string;
  selectedElementUid?: string;
  // It might happen that there is a selected element, but it is not part of the
  // snapshot. This flag indicates if there is any selected element.
  hasSelectedElement: boolean;
  verbose: boolean;
}

interface McpContextOptions {
  // Whether the DevTools windows are exposed as pages for debugging of DevTools.
  experimentalDevToolsDebugging: boolean;
  // Whether all page-like targets are exposed as pages.
  experimentalIncludeAllPages?: boolean;
  // Whether CrUX data should be fetched.
  performanceCrux: boolean;
}

const DEFAULT_TIMEOUT = 5_000;
const NAVIGATION_TIMEOUT = 10_000;

function getNetworkMultiplierFromString(condition: string | null): number {
  const puppeteerCondition =
    condition as keyof typeof PredefinedNetworkConditions;

  switch (puppeteerCondition) {
    case 'Fast 4G':
      return 1;
    case 'Slow 4G':
      return 2.5;
    case 'Fast 3G':
      return 5;
    case 'Slow 3G':
      return 10;
  }
  return 1;
}

function getExtensionFromMimeType(mimeType: string) {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpeg';
    case 'image/webp':
      return 'webp';
  }
  throw new Error(`No mapping for Mime type ${mimeType}.`);
}

export class McpContext implements Context {
  browser: Browser;
  logger: Debugger;

  // The most recent page state.
  #pages: Page[] = [];
  #pageToDevToolsPage = new Map<Page, Page>();
  #selectedPage?: Page;
  // The most recent snapshot.
  #textSnapshot: TextSnapshot | null = null;
  #networkCollector: NetworkCollector;
  #consoleCollector: ConsoleCollector;
  #devtoolsUniverseManager: UniverseManager;
  #extensionRegistry = new ExtensionRegistry();

  #isRunningTrace = false;
  #networkConditionsMap = new WeakMap<Page, string>();
  #cpuThrottlingRateMap = new WeakMap<Page, number>();
  #geolocationMap = new WeakMap<Page, GeolocationOptions>();
  #viewportMap = new WeakMap<Page, Viewport>();
  #userAgentMap = new WeakMap<Page, string>();
  #colorSchemeMap = new WeakMap<Page, 'dark' | 'light'>();
  #dialog?: Dialog;

  #pageIdMap = new WeakMap<Page, number>();
  #nextPageId = 1;

  #nextSnapshotId = 1;
  #traceResults: TraceResult[] = [];

  #locatorClass: typeof Locator;
  #options: McpContextOptions;

  // Idle page reaper: tracks last activity time per page.
  static readonly PAGE_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  static readonly IDLE_CHECK_INTERVAL_MS = 60 * 1000; // 60 seconds
  #pageLastActivity = new Map<Page, number>();
  #idleReaperTimer?: ReturnType<typeof setInterval>;
  #onIdleBrowserEmpty?: () => void;

  #uniqueBackendNodeIdToMcpId = new Map<string, string>();

  private constructor(
    browser: Browser,
    logger: Debugger,
    options: McpContextOptions,
    locatorClass: typeof Locator,
  ) {
    this.browser = browser;
    this.logger = logger;
    this.#locatorClass = locatorClass;
    this.#options = options;

    this.#networkCollector = new NetworkCollector(this.browser);

    this.#consoleCollector = new ConsoleCollector(this.browser, collect => {
      return {
        console: event => {
          collect(event);
        },
        uncaughtError: event => {
          collect(event);
        },
        issue: event => {
          collect(event);
        },
      } as ListenerMap;
    });
    this.#devtoolsUniverseManager = new UniverseManager(this.browser);
  }

  async #init() {
    const pages = await this.createPagesSnapshot();
    await this.#networkCollector.init(pages);
    await this.#consoleCollector.init(pages);
    await this.#devtoolsUniverseManager.init(pages);
  }

  dispose() {
    this.stopIdlePageReaper();
    this.#networkCollector.dispose();
    this.#consoleCollector.dispose();
    this.#devtoolsUniverseManager.dispose();
  }

  /**
   * Record activity on a page, resetting its idle timer.
   */
  touchPage(page: Page): void {
    this.#pageLastActivity.set(page, Date.now());
  }

  /**
   * Record activity on all currently tracked pages.
   */
  touchAllPages(): void {
    const now = Date.now();
    for (const page of this.#pages) {
      this.#pageLastActivity.set(page, now);
    }
  }

  /**
   * Start the periodic idle page reaper.
   * @param onBrowserEmpty - called when all pages have been closed by the reaper.
   */
  startIdlePageReaper(onBrowserEmpty?: () => void): void {
    this.#onIdleBrowserEmpty = onBrowserEmpty;
    // Initialize activity timestamps for all existing pages.
    const now = Date.now();
    for (const page of this.#pages) {
      if (!this.#pageLastActivity.has(page)) {
        this.#pageLastActivity.set(page, now);
      }
    }
    this.#idleReaperTimer = setInterval(() => {
      void this.#reapIdlePages();
    }, McpContext.IDLE_CHECK_INTERVAL_MS);
    // Don't keep the process alive just for the reaper.
    this.#idleReaperTimer.unref();
  }

  stopIdlePageReaper(): void {
    if (this.#idleReaperTimer) {
      clearInterval(this.#idleReaperTimer);
      this.#idleReaperTimer = undefined;
    }
  }

  async #reapIdlePages(): Promise<void> {
    const now = Date.now();
    const idleTimeout = McpContext.PAGE_IDLE_TIMEOUT_MS;
    // Refresh page list from browser to get accurate state.
    let pages: Page[];
    try {
      pages = await this.createPagesSnapshot();
    } catch {
      return; // Browser may be disconnected.
    }

    const pagesToClose: Page[] = [];
    for (const page of pages) {
      const lastActivity = this.#pageLastActivity.get(page);
      // Pages without a recorded timestamp get one now (first seen).
      if (lastActivity === undefined) {
        this.#pageLastActivity.set(page, now);
        continue;
      }
      if (now - lastActivity > idleTimeout) {
        pagesToClose.push(page);
      }
    }

    if (pagesToClose.length === 0) {
      return;
    }

    // Close idle pages. If ALL pages are idle, close them all.
    for (const page of pagesToClose) {
      try {
        this.logger(
          `Closing idle page ${this.#pageIdMap.get(page)}: ${page.url()} (idle ${Math.round((now - (this.#pageLastActivity.get(page) ?? now)) / 1000)}s)`,
        );
        this.#pageLastActivity.delete(page);
        await page.close({runBeforeUnload: false});
      } catch {
        // Page may already be closed.
      }
    }

    // Refresh after closing.
    try {
      pages = await this.createPagesSnapshot();
    } catch {
      pages = [];
    }

    if (pages.length === 0 && this.#onIdleBrowserEmpty) {
      this.logger('All pages closed by idle reaper, triggering browser cleanup');
      this.#onIdleBrowserEmpty();
    }
  }

  static async from(
    browser: Browser,
    logger: Debugger,
    opts: McpContextOptions,
    /* Let tests use unbundled Locator class to avoid overly strict checks within puppeteer that fail when mixing bundled and unbundled class instances */
    locatorClass: typeof Locator = Locator,
  ) {
    const context = new McpContext(browser, logger, opts, locatorClass);
    await context.#init();
    return context;
  }

  resolveCdpRequestId(cdpRequestId: string): number | undefined {
    const selectedPage = this.getSelectedPage();
    if (!cdpRequestId) {
      this.logger('no network request');
      return;
    }
    const request = this.#networkCollector.find(selectedPage, request => {
      // @ts-expect-error id is internal.
      return request.id === cdpRequestId;
    });
    if (!request) {
      this.logger('no network request for ' + cdpRequestId);
      return;
    }
    return this.#networkCollector.getIdForResource(request);
  }

  resolveCdpElementId(cdpBackendNodeId: number): string | undefined {
    if (!cdpBackendNodeId) {
      this.logger('no cdpBackendNodeId');
      return;
    }
    if (this.#textSnapshot === null) {
      this.logger('no text snapshot');
      return;
    }
    // TODO: index by backendNodeId instead.
    const queue = [this.#textSnapshot.root];
    while (queue.length) {
      const current = queue.pop()!;
      if (current.backendNodeId === cdpBackendNodeId) {
        return current.id;
      }
      for (const child of current.children) {
        queue.push(child);
      }
    }
    return;
  }

  getNetworkRequests(includePreservedRequests?: boolean): HTTPRequest[] {
    const page = this.getSelectedPage();
    return this.#networkCollector.getData(page, includePreservedRequests);
  }

  getConsoleData(
    includePreservedMessages?: boolean,
  ): Array<ConsoleMessage | Error | DevTools.AggregatedIssue | UncaughtError> {
    const page = this.getSelectedPage();
    return this.#consoleCollector.getData(page, includePreservedMessages);
  }

  getDevToolsUniverse(): TargetUniverse | null {
    return this.#devtoolsUniverseManager.get(this.getSelectedPage());
  }

  getConsoleMessageStableId(
    message: ConsoleMessage | Error | DevTools.AggregatedIssue | UncaughtError,
  ): number {
    return this.#consoleCollector.getIdForResource(message);
  }

  getConsoleMessageById(
    id: number,
  ): ConsoleMessage | Error | DevTools.AggregatedIssue | UncaughtError {
    return this.#consoleCollector.getById(this.getSelectedPage(), id);
  }

  async newPage(background?: boolean): Promise<Page> {
    const page = await this.browser.newPage({background});
    await this.createPagesSnapshot();
    this.selectPage(page); // Also touches the page via selectPage.
    this.#networkCollector.addPage(page);
    this.#consoleCollector.addPage(page);
    return page;
  }
  async closePage(pageId: number): Promise<void> {
    if (this.#pages.length === 1) {
      throw new Error(CLOSE_PAGE_ERROR);
    }
    const page = this.getPageById(pageId);
    await page.close({runBeforeUnload: false});
  }

  getNetworkRequestById(reqid: number): HTTPRequest {
    return this.#networkCollector.getById(this.getSelectedPage(), reqid);
  }

  setNetworkConditions(conditions: string | null): void {
    const page = this.getSelectedPage();
    if (conditions === null) {
      this.#networkConditionsMap.delete(page);
    } else {
      this.#networkConditionsMap.set(page, conditions);
    }
    this.#updateSelectedPageTimeouts();
  }

  getNetworkConditions(): string | null {
    const page = this.getSelectedPage();
    return this.#networkConditionsMap.get(page) ?? null;
  }

  setCpuThrottlingRate(rate: number): void {
    const page = this.getSelectedPage();
    this.#cpuThrottlingRateMap.set(page, rate);
    this.#updateSelectedPageTimeouts();
  }

  getCpuThrottlingRate(): number {
    const page = this.getSelectedPage();
    return this.#cpuThrottlingRateMap.get(page) ?? 1;
  }

  setGeolocation(geolocation: GeolocationOptions | null): void {
    const page = this.getSelectedPage();
    if (geolocation === null) {
      this.#geolocationMap.delete(page);
    } else {
      this.#geolocationMap.set(page, geolocation);
    }
  }

  getGeolocation(): GeolocationOptions | null {
    const page = this.getSelectedPage();
    return this.#geolocationMap.get(page) ?? null;
  }

  setViewport(viewport: Viewport | null): void {
    const page = this.getSelectedPage();
    if (viewport === null) {
      this.#viewportMap.delete(page);
    } else {
      this.#viewportMap.set(page, viewport);
    }
  }

  getViewport(): Viewport | null {
    const page = this.getSelectedPage();
    return this.#viewportMap.get(page) ?? null;
  }

  setUserAgent(userAgent: string | null): void {
    const page = this.getSelectedPage();
    if (userAgent === null) {
      this.#userAgentMap.delete(page);
    } else {
      this.#userAgentMap.set(page, userAgent);
    }
  }

  getUserAgent(): string | null {
    const page = this.getSelectedPage();
    return this.#userAgentMap.get(page) ?? null;
  }

  setColorScheme(scheme: 'dark' | 'light' | null): void {
    const page = this.getSelectedPage();
    if (scheme === null) {
      this.#colorSchemeMap.delete(page);
    } else {
      this.#colorSchemeMap.set(page, scheme);
    }
  }

  getColorScheme(): 'dark' | 'light' | null {
    const page = this.getSelectedPage();
    return this.#colorSchemeMap.get(page) ?? null;
  }

  setIsRunningPerformanceTrace(x: boolean): void {
    this.#isRunningTrace = x;
  }

  isRunningPerformanceTrace(): boolean {
    return this.#isRunningTrace;
  }

  isCruxEnabled(): boolean {
    return this.#options.performanceCrux;
  }

  getDialog(): Dialog | undefined {
    return this.#dialog;
  }

  clearDialog(): void {
    this.#dialog = undefined;
  }

  getSelectedPage(): Page {
    const page = this.#selectedPage;
    if (!page) {
      throw new Error('No page selected');
    }
    if (page.isClosed()) {
      throw new Error(
        `The selected page has been closed. Call ${listPages.name} to see open pages.`,
      );
    }
    return page;
  }

  getPageById(pageId: number): Page {
    const page = this.#pages.find(p => this.#pageIdMap.get(p) === pageId);
    if (!page) {
      throw new Error('No page found');
    }
    return page;
  }

  getPageId(page: Page): number | undefined {
    return this.#pageIdMap.get(page);
  }

  #dialogHandler = (dialog: Dialog): void => {
    this.#dialog = dialog;
  };

  isPageSelected(page: Page): boolean {
    return this.#selectedPage === page;
  }

  selectPage(newPage: Page): void {
    const oldPage = this.#selectedPage;
    if (oldPage) {
      oldPage.off('dialog', this.#dialogHandler);
      void oldPage.emulateFocusedPage(false).catch(error => {
        this.logger('Error turning off focused page emulation', error);
      });
    }
    this.#selectedPage = newPage;
    this.touchPage(newPage);
    newPage.on('dialog', this.#dialogHandler);
    this.#updateSelectedPageTimeouts();
    void newPage.emulateFocusedPage(true).catch(error => {
      this.logger('Error turning on focused page emulation', error);
    });
  }

  #updateSelectedPageTimeouts() {
    const page = this.getSelectedPage();
    // For waiters 5sec timeout should be sufficient.
    // Increased in case we throttle the CPU
    const cpuMultiplier = this.getCpuThrottlingRate();
    page.setDefaultTimeout(DEFAULT_TIMEOUT * cpuMultiplier);
    // 10sec should be enough for the load event to be emitted during
    // navigations.
    // Increased in case we throttle the network requests
    const networkMultiplier = getNetworkMultiplierFromString(
      this.getNetworkConditions(),
    );
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT * networkMultiplier);
  }

  getNavigationTimeout() {
    const page = this.getSelectedPage();
    return page.getDefaultNavigationTimeout();
  }

  getAXNodeByUid(uid: string) {
    return this.#textSnapshot?.idToNode.get(uid);
  }

  async getElementByUid(uid: string): Promise<ElementHandle<Element>> {
    if (!this.#textSnapshot?.idToNode.size) {
      throw new Error(
        `No snapshot found. Use ${takeSnapshot.name} to capture one.`,
      );
    }
    const node = this.#textSnapshot?.idToNode.get(uid);
    if (!node) {
      throw new Error('No such element found in the snapshot.');
    }
    const message = `Element with uid ${uid} no longer exists on the page.`;
    try {
      const handle = await node.elementHandle();
      if (!handle) {
        throw new Error(message);
      }
      return handle;
    } catch (error) {
      throw new Error(message, {
        cause: error,
      });
    }
  }

  /**
   * Creates a snapshot of the pages.
   */
  async createPagesSnapshot(): Promise<Page[]> {
    const allPages = await this.browser.pages(
      this.#options.experimentalIncludeAllPages,
    );

    for (const page of allPages) {
      if (!this.#pageIdMap.has(page)) {
        this.#pageIdMap.set(page, this.#nextPageId++);
      }
    }

    this.#pages = allPages.filter(page => {
      // If we allow debugging DevTools windows, return all pages.
      // If we are in regular mode, the user should only see non-DevTools page.
      return (
        this.#options.experimentalDevToolsDebugging ||
        !page.url().startsWith('devtools://')
      );
    });

    if (
      (!this.#selectedPage || this.#pages.indexOf(this.#selectedPage) === -1) &&
      this.#pages[0]
    ) {
      this.selectPage(this.#pages[0]);
    }

    await this.detectOpenDevToolsWindows();

    return this.#pages;
  }

  async detectOpenDevToolsWindows() {
    this.logger('Detecting open DevTools windows');
    const pages = await this.browser.pages(
      this.#options.experimentalIncludeAllPages,
    );
    this.#pageToDevToolsPage = new Map<Page, Page>();
    for (const devToolsPage of pages) {
      if (devToolsPage.url().startsWith('devtools://')) {
        try {
          this.logger('Calling getTargetInfo for ' + devToolsPage.url());
          const data = await devToolsPage
            // @ts-expect-error no types for _client().
            ._client()
            .send('Target.getTargetInfo');
          const devtoolsPageTitle = data.targetInfo.title;
          const urlLike = extractUrlLikeFromDevToolsTitle(devtoolsPageTitle);
          if (!urlLike) {
            continue;
          }
          // TODO: lookup without a loop.
          for (const page of this.#pages) {
            if (urlsEqual(page.url(), urlLike)) {
              this.#pageToDevToolsPage.set(page, devToolsPage);
            }
          }
        } catch (error) {
          this.logger('Issue occurred while trying to find DevTools', error);
        }
      }
    }
  }

  getPages(): Page[] {
    return this.#pages;
  }

  getDevToolsPage(page: Page): Page | undefined {
    return this.#pageToDevToolsPage.get(page);
  }

  async getDevToolsData(): Promise<DevToolsData> {
    try {
      this.logger('Getting DevTools UI data');
      const selectedPage = this.getSelectedPage();
      const devtoolsPage = this.getDevToolsPage(selectedPage);
      if (!devtoolsPage) {
        this.logger('No DevTools page detected');
        return {};
      }
      const {cdpRequestId, cdpBackendNodeId} = await devtoolsPage.evaluate(
        async () => {
          // @ts-expect-error no types
          const UI = await import('/bundled/ui/legacy/legacy.js');
          // @ts-expect-error no types
          const SDK = await import('/bundled/core/sdk/sdk.js');
          const request = UI.Context.Context.instance().flavor(
            SDK.NetworkRequest.NetworkRequest,
          );
          const node = UI.Context.Context.instance().flavor(
            SDK.DOMModel.DOMNode,
          );
          return {
            cdpRequestId: request?.requestId(),
            cdpBackendNodeId: node?.backendNodeId(),
          };
        },
      );
      return {cdpBackendNodeId, cdpRequestId};
    } catch (err) {
      this.logger('error getting devtools data', err);
    }
    return {};
  }

  /**
   * Creates a text snapshot of a page.
   */
  async createTextSnapshot(
    verbose = false,
    devtoolsData: DevToolsData | undefined = undefined,
  ): Promise<void> {
    const page = this.getSelectedPage();
    const rootNode = await page.accessibility.snapshot({
      includeIframes: true,
      interestingOnly: !verbose,
    });
    if (!rootNode) {
      return;
    }

    const snapshotId = this.#nextSnapshotId++;
    // Iterate through the whole accessibility node tree and assign node ids that
    // will be used for the tree serialization and mapping ids back to nodes.
    let idCounter = 0;
    const idToNode = new Map<string, TextSnapshotNode>();
    const seenUniqueIds = new Set<string>();
    const assignIds = (node: SerializedAXNode): TextSnapshotNode => {
      let id = '';
      // @ts-expect-error untyped loaderId & backendNodeId.
      const uniqueBackendId = `${node.loaderId}_${node.backendNodeId}`;
      if (this.#uniqueBackendNodeIdToMcpId.has(uniqueBackendId)) {
        // Re-use MCP exposed ID if the uniqueId is the same.
        id = this.#uniqueBackendNodeIdToMcpId.get(uniqueBackendId)!;
      } else {
        // Only generate a new ID if we have not seen the node before.
        id = `${snapshotId}_${idCounter++}`;
        this.#uniqueBackendNodeIdToMcpId.set(uniqueBackendId, id);
      }
      seenUniqueIds.add(uniqueBackendId);

      const nodeWithId: TextSnapshotNode = {
        ...node,
        id,
        children: node.children
          ? node.children.map(child => assignIds(child))
          : [],
      };

      // The AXNode for an option doesn't contain its `value`.
      // Therefore, set text content of the option as value.
      if (node.role === 'option') {
        const optionText = node.name;
        if (optionText) {
          nodeWithId.value = optionText.toString();
        }
      }

      idToNode.set(nodeWithId.id, nodeWithId);
      return nodeWithId;
    };

    const rootNodeWithId = assignIds(rootNode);
    this.#textSnapshot = {
      root: rootNodeWithId,
      snapshotId: String(snapshotId),
      idToNode,
      hasSelectedElement: false,
      verbose,
    };
    const data = devtoolsData ?? (await this.getDevToolsData());
    if (data?.cdpBackendNodeId) {
      this.#textSnapshot.hasSelectedElement = true;
      this.#textSnapshot.selectedElementUid = this.resolveCdpElementId(
        data?.cdpBackendNodeId,
      );
    }

    // Clean up unique IDs that we did not see anymore.
    for (const key of this.#uniqueBackendNodeIdToMcpId.keys()) {
      if (!seenUniqueIds.has(key)) {
        this.#uniqueBackendNodeIdToMcpId.delete(key);
      }
    }
  }

  getTextSnapshot(): TextSnapshot | null {
    return this.#textSnapshot;
  }

  async saveTemporaryFile(
    data: Uint8Array<ArrayBufferLike>,
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
  ): Promise<{filename: string}> {
    try {
      const dir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'chrome-devtools-mcp-'),
      );

      const filename = path.join(
        dir,
        `screenshot.${getExtensionFromMimeType(mimeType)}`,
      );
      await fs.writeFile(filename, data);
      return {filename};
    } catch (err) {
      this.logger(err);
      throw new Error('Could not save a screenshot to a file', {cause: err});
    }
  }
  async saveFile(
    data: Uint8Array<ArrayBufferLike>,
    filename: string,
  ): Promise<{filename: string}> {
    try {
      const filePath = path.resolve(filename);
      await fs.writeFile(filePath, data);
      return {filename};
    } catch (err) {
      this.logger(err);
      throw new Error('Could not save a screenshot to a file', {cause: err});
    }
  }

  storeTraceRecording(result: TraceResult): void {
    // Clear the trace results because we only consume the latest trace currently.
    this.#traceResults = [];
    this.#traceResults.push(result);
  }

  recordedTraces(): TraceResult[] {
    return this.#traceResults;
  }

  getWaitForHelper(
    page: Page,
    cpuMultiplier: number,
    networkMultiplier: number,
  ) {
    return new WaitForHelper(page, cpuMultiplier, networkMultiplier);
  }

  waitForEventsAfterAction(
    action: () => Promise<unknown>,
    options?: {timeout?: number},
  ): Promise<void> {
    const page = this.getSelectedPage();
    const cpuMultiplier = this.getCpuThrottlingRate();
    const networkMultiplier = getNetworkMultiplierFromString(
      this.getNetworkConditions(),
    );
    const waitForHelper = this.getWaitForHelper(
      page,
      cpuMultiplier,
      networkMultiplier,
    );
    return waitForHelper.waitForEventsAfterAction(action, options);
  }

  getNetworkRequestStableId(request: HTTPRequest): number {
    return this.#networkCollector.getIdForResource(request);
  }

  waitForTextOnPage(text: string, timeout?: number): Promise<Element> {
    const page = this.getSelectedPage();
    const frames = page.frames();

    let locator = this.#locatorClass.race(
      frames.flatMap(frame => [
        frame.locator(`aria/${text}`),
        frame.locator(`text/${text}`),
      ]),
    );

    if (timeout) {
      locator = locator.setTimeout(timeout);
    }

    return locator.wait();
  }

  /**
   * We need to ignore favicon request as they make our test flaky
   */
  async setUpNetworkCollectorForTesting() {
    this.#networkCollector = new NetworkCollector(this.browser, collect => {
      return {
        request: req => {
          if (req.url().includes('favicon.ico')) {
            return;
          }
          collect(req);
        },
      } as ListenerMap;
    });
    await this.#networkCollector.init(await this.browser.pages());
  }

  async installExtension(extensionPath: string): Promise<string> {
    const id = await this.browser.installExtension(extensionPath);
    await this.#extensionRegistry.registerExtension(id, extensionPath);
    return id;
  }

  async uninstallExtension(id: string): Promise<void> {
    await this.browser.uninstallExtension(id);
    this.#extensionRegistry.remove(id);
  }

  listExtensions(): InstalledExtension[] {
    return this.#extensionRegistry.list();
  }

  getExtension(id: string): InstalledExtension | undefined {
    return this.#extensionRegistry.getById(id);
  }
}
