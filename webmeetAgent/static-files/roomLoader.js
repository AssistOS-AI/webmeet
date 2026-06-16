import WebSkel from '/web-libs/webskel/webskel.mjs';
import { createAgentClient } from '/MCPBrowserClient.js';

const ROOM_ID_PATTERN = /^room_[0-9a-fA-F-]{36}$/;
const COMPONENT_ROOT = new URL('../IDE-plugins/webmeet-tool-button/', import.meta.url);
const PLUGIN_CONFIG_URL = new URL('config.json', COMPONENT_ROOT);

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

function createMcpServices() {
  const clients = new Map();
  return {
    getClient(agentId) {
      const key = String(agentId || '').trim();
      if (!key) throw new Error('Agent id is required.');
      if (!clients.has(key)) {
        clients.set(key, createAgentClient(`/${encodeURIComponent(key)}/mcp`));
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
  const base = String(entry.path || entry.base || `components/${name}/${name}`).trim();
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

  await registerComponent(webSkel, componentDefinitions[0]);
  closeInitialLoader();
  await webSkel.changeToDynamicPage('webmeet-dashboard', 'webmeet-dashboard', null, true);
}

start().catch((error) => {
  console.error('[WebMeet] Initialization failed:', error);
  closeInitialLoader();
  const message = error instanceof Error ? error.message : String(error);
  if (window.__WEBMEET_GUEST_ENTRY__) {
    showAccessDenied('This public room link is invalid, expired, archived, or not available to guests.');
    return;
  }
  document.querySelector('#page_content').innerHTML = `
    <div style="padding: 20px; color: #d32f2f; background: #ffebee; border-radius: 4px; margin: 20px; border: 1px solid #f44336; font-family: sans-serif;">
      <h3 style="margin-top: 0;">Application Error</h3>
      <p>${message}</p>
      <button onclick="window.location.reload()" style="padding: 8px 16px; cursor: pointer; background: #d32f2f; color: white; border: none; border-radius: 4px;">Retry</button>
    </div>
  `;
});
