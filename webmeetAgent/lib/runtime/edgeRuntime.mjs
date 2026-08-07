import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LIVEKIT_SIGNAL_PATH = '/base-agent-additional-server/liveKitServerAgent/7880/';
const LIVEKIT_TWIRP_PREFIX = '/base-agent-additional-server/liveKitServerAgent/7880/twirp/livekit.';
const LIVEKIT_PRIVATE_SERVICES = new Set(['RoomService', 'AgentDispatchService']);
const PRIVATE_ASSERTION_HEADER = 'Ploinky-Agent-Assertion';

function requireNonEmptyString(value, label) {
    const normalized = String(value || '').trim();
    if (!normalized) throw new Error(`${label} is required.`);
    return normalized;
}

function runtimeModuleUrl(fileName, env = process.env) {
    const agentLibDir = requireNonEmptyString(env.PLOINKY_AGENT_LIB_DIR || '/Agent', 'PLOINKY_AGENT_LIB_DIR');
    return pathToFileURL(path.join(agentLibDir, 'lib', fileName)).href;
}

async function loadEdgeRuntime(env = process.env) {
    const [topologyModule, assertionModule] = await Promise.all([
        import(runtimeModuleUrl('edgeTopology.mjs', env)),
        import(runtimeModuleUrl('agentAssertion.mjs', env)),
    ]);
    if (typeof topologyModule.readEdgeTopology !== 'function') {
        throw new Error('Ploinky edge topology runtime is unavailable.');
    }
    if (typeof assertionModule.signPrivateRouterAssertion !== 'function') {
        throw new Error('Ploinky private assertion signer is unavailable.');
    }
    return { ...topologyModule, ...assertionModule };
}

function normalizeSignalUrl(routerPath = LIVEKIT_SIGNAL_PATH) {
    const selectedPath = requireNonEmptyString(routerPath, 'LiveKit Router path');
    if (!selectedPath.startsWith('/') || selectedPath.includes('..') || selectedPath.includes('?') || selectedPath.includes('#')) {
        throw new Error('LiveKit Router path is invalid.');
    }
    return selectedPath;
}

function validateTurnTopology(topology) {
    const turn = topology?.media?.turn;
    if (turn === undefined) return null;
    const urls = Array.isArray(turn?.urls)
        ? [...new Set(turn.urls.map((value) => String(value || '').trim()).filter(Boolean))]
        : [];
    if (!urls.length || urls.some((url) => !/^turns?:/i.test(url))) {
        throw new Error('Edge topology must declare external TURN URLs.');
    }
    if (turn?.credentialMode !== 'turn-rest') {
        throw new Error('Edge topology TURN credentialMode must be turn-rest.');
    }
    const credentialPath = requireNonEmptyString(turn?.credentialPath, 'TURN credential path');
    if (!credentialPath.startsWith('/') || credentialPath.includes('..') || credentialPath.includes('?') || credentialPath.includes('#')) {
        throw new Error('TURN credential path is invalid.');
    }
    return { urls, credentialPath };
}

function validateGeneration(topology) {
    const configurationGeneration = String(topology?.configurationGeneration || '').trim();
    const publicationGeneration = topology?.publicationGeneration;
    if (!configurationGeneration || !Number.isSafeInteger(Number(publicationGeneration))) {
        throw new Error('Edge topology generation metadata is invalid.');
    }
    if (topology?.state !== 'ready') throw new Error('Edge topology is not ready.');
    return { configurationGeneration, publicationGeneration: Number(publicationGeneration) };
}

function validateCredentialResponse(payload, topologyUrls, now = Date.now()) {
    const urls = Array.isArray(payload?.urls)
        ? [...new Set(payload.urls.map((value) => String(value || '').trim()).filter(Boolean))]
        : [];
    const username = requireNonEmptyString(payload?.username, 'TURN username');
    const password = requireNonEmptyString(payload?.password, 'TURN password');
    const expiresAt = requireNonEmptyString(payload?.expiresAt, 'TURN expiry');
    const expiresAtMs = Date.parse(expiresAt);
    if (!urls.length || urls.some((url) => !topologyUrls.includes(url))) {
        throw new Error('TURN broker returned an URL outside the current topology generation.');
    }
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now + 30_000) {
        throw new Error('TURN broker returned expired or unusably short-lived credentials.');
    }
    return { urls, username, password, expiresAt: new Date(expiresAtMs).toISOString() };
}

export async function resolveEdgeJoinMaterial(context, { roomName, participantIdentity } = {}) {
    if (typeof context?.resolveEdgeJoinMaterial === 'function') {
        return context.resolveEdgeJoinMaterial({ roomName, participantIdentity });
    }
    const targetRoomName = requireNonEmptyString(roomName, 'LiveKit room name');
    const targetParticipant = requireNonEmptyString(participantIdentity, 'LiveKit participant identity');
    const internalRouterUrl = requireNonEmptyString(process.env.PLOINKY_INTERNAL_ROUTER_URL, 'PLOINKY_INTERNAL_ROUTER_URL');
    const { readEdgeTopology, signPrivateRouterAssertion } = await loadEdgeRuntime();
    const topology = readEdgeTopology({ file: process.env.PLOINKY_EDGE_TOPOLOGY_FILE });
    const generation = validateGeneration(topology);
    const livekitUrl = normalizeSignalUrl();
    const turnTopology = validateTurnTopology(topology);
    if (!turnTopology) {
        return {
            livekitUrl,
            rtcConfig: {
                iceTransportPolicy: 'all',
                iceServers: [],
            },
            configurationGeneration: generation.configurationGeneration,
            publicationGeneration: generation.publicationGeneration,
        };
    }
    const body = Buffer.from(JSON.stringify({ roomName: targetRoomName, participantIdentity: targetParticipant }));
    const assertion = signPrivateRouterAssertion({
        method: 'POST',
        path: turnTopology.credentialPath,
        body,
    });
    const response = await fetch(new URL(turnTopology.credentialPath, internalRouterUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            [PRIVATE_ASSERTION_HEADER]: assertion,
        },
        body,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(`TURN credential broker failed with HTTP ${response.status}.`);
    }
    const credentials = validateCredentialResponse(payload, turnTopology.urls);
    return {
        livekitUrl,
        rtcConfig: {
            iceTransportPolicy: 'all',
            iceServers: [{
                urls: credentials.urls,
                username: credentials.username,
                credential: credentials.password,
            }],
        },
        turnExpiresAt: credentials.expiresAt,
        configurationGeneration: generation.configurationGeneration,
        publicationGeneration: generation.publicationGeneration,
    };
}

export async function resolvePrivateLiveKitCall({ serviceName = 'RoomService', methodName, body, env = process.env } = {}) {
    const targetService = requireNonEmptyString(serviceName, 'LiveKit service');
    if (!LIVEKIT_PRIVATE_SERVICES.has(targetService)) {
        throw new Error('LiveKit service is invalid.');
    }
    const targetMethod = requireNonEmptyString(methodName, `LiveKit ${targetService} method`);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(targetMethod)) {
        throw new Error(`LiveKit ${targetService} method is invalid.`);
    }
    const requestBody = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
    const internalRouterUrl = requireNonEmptyString(env.PLOINKY_INTERNAL_ROUTER_URL, 'PLOINKY_INTERNAL_ROUTER_URL');
    const { signPrivateRouterAssertion } = await loadEdgeRuntime(env);
    const requestPath = `${LIVEKIT_TWIRP_PREFIX}${targetService}/${targetMethod}`;
    return {
        url: new URL(requestPath, internalRouterUrl),
        requestPath,
        assertion: signPrivateRouterAssertion({ method: 'POST', path: requestPath, body: requestBody, env }),
    };
}

export const _test = {
    normalizeSignalUrl,
    validateCredentialResponse,
    validateTurnTopology,
};
