import WebSkel from '/explorer/shared/libs/webskel/webskel.mjs';
import { initializeTheme } from '/explorer/shared/ui/theme.js';

const ROOM_ID_PATTERN = /^room_[0-9a-fA-F-]{36}$/;
const MCP_PROTOCOL_VERSION = '2025-06-18';
const COMPONENT_ROOT = new URL('../IDE-plugins/webmeet-tool-button/', import.meta.url);
const PLUGIN_CONFIG_URL = new URL('config.json', COMPONENT_ROOT);

initializeTheme();

function getRoomIdParam() {
  const roomId = String(new URLSearchParams(window.location.search || '').get('roomId') || '').trim();
  return ROOM_ID_PATTERN.test(roomId) ? roomId : '';
}

function getWebMeetAgentName() {
  const firstPathSegment = String(window.location.pathname || '').split('/').filter(Boolean)[0] || '';
  return firstPathSegment || 'webmeetAgent';
}

function buildLoginUrl() {
  return `/auth/login?${new URLSearchParams({ returnTo: `${window.location.pathname}${window.location.search || ''}` }).toString()}`;
}

function closeInitialLoader() {
  const loader = document.querySelector('#before_webskel_loader');
  try { loader?.close?.(); } catch (_) {}
  loader?.remove?.();
}

function closeStartupLoaders() {
  closeInitialLoader();
  for (const loader of document.querySelectorAll('dialog.spinner.spinner-default-style')) {
    try { loader.close?.(); } catch (_) {}
    loader.remove();
  }
}

function waitForDashboardReady() {
  if (window.__WEBMEET_DASHBOARD_READY__ === true) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onReady = () => {
      window.removeEventListener('webmeet-dashboard-ready', onReady);
      resolve();
    };
    window.addEventListener('webmeet-dashboard-ready', onReady, { once: true });
  });
}

function showAccessDenied(message = '') {
  closeInitialLoader();
  const content = document.querySelector('#page_content');
  if (!content) return;
  content.innerHTML = `
    <section class="webmeet-access-denied" role="alert">
      <div class="webmeet-access-panel">
        <h1>Authentication required</h1>
        <p>${message || 'You are not authenticated and do not have access to this WebMeet room. Sign in first, or open a valid public room link.'}</p>
        <a class="webmeet-login-link" href="${buildLoginUrl()}">Sign in</a>
      </div>
    </section>
  `;
}

window.__WEBMEET_SHOW_ACCESS_DENIED__ = showAccessDenied;

async function getAuthState() {
  try {
    const response = await fetch('/auth/token', { cache: 'no-store', credentials: 'include' });
    if (!response.ok) {
      return { authenticated: false, userAuthenticated: false, guest: false, user: null };
    }
    const payload = await response.json().catch(() => ({}));
    const roles = Array.isArray(payload?.user?.roles) ? payload.user.roles.map((role) => String(role || '').toLowerCase()) : [];
    const guest = roles.includes('guest');
    return {
      authenticated: true,
      userAuthenticated: !guest,
      guest,
      user: payload?.user || null
    };
  } catch (_) {
    return { authenticated: false, userAuthenticated: false, guest: false, user: null };
  }
}

function parseToolResult(result = {}) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const jsonBlock = blocks.find((block) => block?.type === 'json' && block.json !== undefined);
  if (jsonBlock) return { json: jsonBlock.json, blocks, raw: result };
  const textBlock = blocks.find((block) => block?.type === 'text' && typeof block.text === 'string' && !block.text.startsWith('stderr:'))
    || blocks.find((block) => block?.type === 'text' && typeof block.text === 'string');
  const text = textBlock?.text || '';
  if (text && !text.startsWith('stderr:')) {
    try {
      return { json: JSON.parse(text), text, blocks, raw: result };
    } catch (_) {}
  }
  return { text, blocks, raw: result };
}

function createJsonRpcAgentClient(agentId) {
  const endpoint = `/${encodeURIComponent(agentId)}/mcp`;
  let sessionId = '';
  let protocolVersion = MCP_PROTOCOL_VERSION;
  let connected = false;
  let connectPromise = null;
  let messageId = 0;

  async function send(method, params = {}, { notification = false } = {}) {
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json');
    if (sessionId) headers.set('mcp-session-id', sessionId);
    if (protocolVersion) headers.set('mcp-protocol-version', protocolVersion);

    const payload = {
      jsonrpc: '2.0',
      method,
      params
    };
    if (!notification) {
      messageId += 1;
      payload.id = String(messageId);
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      credentials: 'include',
      cache: 'no-store'
    });

    const receivedSession = response.headers.get('mcp-session-id');
    if (receivedSession) sessionId = receivedSession;
    const receivedProtocol = response.headers.get('mcp-protocol-version');
    if (receivedProtocol) protocolVersion = receivedProtocol;

    if (notification && (response.status === 202 || response.status === 204)) {
      return {};
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`MCP request failed: HTTP ${response.status}${text ? ` - ${text}` : ''}`);
    }
    if (response.status === 204) {
      return {};
    }
    const data = await response.json().catch(() => ({}));
    if (!notification && data?.error) {
      throw new Error(data.error.message || 'MCP request failed');
    }
    return data?.result || {};
  }

  async function connect() {
    if (connected) return;
    if (connectPromise) {
      await connectPromise;
      return;
    }
    connectPromise = (async () => {
      await send('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'webmeet-room-loader',
          version: '1.0.0'
        }
      });
      await send('notifications/initialized', {}, { notification: true });
      connected = true;
    })();
    try {
      await connectPromise;
    } finally {
      connectPromise = null;
    }
  }

  return {
    async callTool(name, args = {}) {
      await connect();
      return await send('tools/call', {
        name,
        arguments: args
      });
    }
  };
}

function createMcpServices() {
  const clients = new Map();
  return {
    getClient(agentId) {
      const key = String(agentId || '').trim();
      if (!key) throw new Error('Agent id is required.');
      if (!clients.has(key)) {
        clients.set(key, createJsonRpcAgentClient(key));
      }
      return clients.get(key);
    },
    async callTool(agentId, tool, args = {}) {
      const result = await this.getClient(agentId).callTool(tool, args);
      return parseToolResult(result);
    }
  };
}

async function fetchText(url, description) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${description} (${response.status})`);
  return response.text();
}

async function fetchJson(url, description) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${description} (${response.status})`);
  return response.json();
}

function normalizeComponentDefinition(entry = {}) {
  const name = String(entry.component || entry.name || '').trim();
  if (!name) return null;
  const presenterClassName = String(entry.presenter || entry.presenterClassName || '').trim();
  const type = entry.type === 'modal' || entry.type === 'modals' ? 'modals' : 'components';
  const rawBase = String(entry.baseUrl || entry.path || entry.base || `components/${name}/${name}`).trim();
  const base = rawBase.startsWith('explorer/') ? `/${rawBase}` : rawBase;
  return {
    name,
    type,
    presenterClassName,
    base
  };
}

async function loadComponentDefinitions() {
  const config = await fetchJson(PLUGIN_CONFIG_URL, 'Failed to load WebMeet plugin config');
  const dependencies = Array.isArray(config?.dependencies) ? config.dependencies : [];
  const definitions = dependencies
    .map(normalizeComponentDefinition)
    .filter(Boolean);
  if (!definitions.some((definition) => definition.name === 'webmeet-dashboard')) {
    throw new Error('WebMeet plugin config must declare webmeet-dashboard.');
  }
  return definitions;
}

async function registerComponent(webSkel, definition) {
  if (customElements.get(definition.name)) return;
  const baseUrl = new URL(definition.base, COMPONENT_ROOT).toString();
  const [template, css, module] = await Promise.all([
    fetchText(`${baseUrl}.html`, `Failed to load ${definition.name} template`),
    fetchText(`${baseUrl}.css`, `Failed to load ${definition.name} stylesheet`),
    import(`${baseUrl}.js?runtime=${Date.now().toString(36)}`)
  ]);
  await webSkel.defineComponent({
    name: definition.name,
    type: definition.type,
    loadedTemplate: template,
    loadedCSSs: [css],
    presenterClassName: definition.presenterClassName,
    presenterModule: module
  });
}

window.showApplicationError = window.showApplicationError || (async (_title, message) => {
  throw new Error(message || 'Application error');
});

async function start() {
  const roomId = getRoomIdParam();
  const authState = await getAuthState();
  const userAuthenticated = authState.userAuthenticated === true;
  const guestEntry = !userAuthenticated && Boolean(roomId);

  if (!userAuthenticated && !roomId) {
    showAccessDenied('Sign in to view your WebMeet rooms, or open a valid public room link.');
    return;
  }

  window.__WEBMEET_AGENT_NAME__ = getWebMeetAgentName();
  window.__WEBMEET_INITIAL_ROOM_ID__ = roomId;
  window.__WEBMEET_AUTHENTICATED__ = userAuthenticated;
  window.__WEBMEET_GUEST_ENTRY__ = guestEntry;

  const webSkel = await WebSkel.initialise('./static-files/webskel.json');
  const componentDefinitions = await loadComponentDefinitions();
  componentDefinitions.forEach((def) => {
    if (!webSkel.configs.components.find((component) => component.name === def.name)) {
      webSkel.configs.components.push(def);
    }
  });

  const appServices = createMcpServices();
  const assistOS = {
    UI: webSkel,
    webSkel,
    appServices,
    user: userAuthenticated ? authState.user : null,
    workspace: { plugins: {}, appPlugins: {} },
    pluginSettings: {}
  };
  window.UI = webSkel;
  window.webSkel = webSkel;
  window.assistOS = assistOS;
  webSkel.appServices = appServices;

  const originalShowModal = webSkel.showModal?.bind(webSkel);
  webSkel.showModal = async (name, payload = {}, expectResult = false) => {
    if (name === 'confirm-action-modal') {
      return window.confirm(String(payload?.message || 'Continue?'));
    }
    await webSkel.ensureComponentRegistered?.(name);
    return originalShowModal(name, payload, expectResult);
  };

  webSkel.setDomElementForPages(document.querySelector('#page_content'));
  webSkel.setLoading(document.querySelector('#before_webskel_loader')?.innerHTML || '');
  webSkel.ensureComponentRegistered = async (componentName) => {
    const definition = componentDefinitions.find((entry) => entry.name === componentName);
    if (definition) await registerComponent(webSkel, definition);
    return null;
  };

  const pageComponentDefinitions = componentDefinitions.filter((definition) => definition.type !== 'modals');
  await Promise.all(pageComponentDefinitions.map((definition) => registerComponent(webSkel, definition)));
/*  const dashboardReady = waitForDashboardReady();
  await dashboardReady;*/
  closeStartupLoaders();
  webSkel.changeToDynamicPage('webmeet-dashboard', 'webmeet-dashboard', null, true);
}

start().catch((error) => {
  console.error('[WebMeet] Initialization failed:', error);
  closeStartupLoaders();
  const message = error instanceof Error ? error.message : String(error);
  const isComponentLoadError = /Failed to load .+ (template|stylesheet)|Failed to fetch dynamically imported module/i.test(message);
  if (window.__WEBMEET_GUEST_ENTRY__ && !isComponentLoadError) {
    showAccessDenied('This public room link is invalid, expired, archived, or not available to guests.');
    return;
  }
  document.querySelector('#page_content').innerHTML = `
    <div class="webmeet-room-loader-error" role="alert">
      <h3>Application Error</h3>
      <p>${message}</p>
      <button type="button" onclick="window.location.reload()">Retry</button>
    </div>
  `;
});
