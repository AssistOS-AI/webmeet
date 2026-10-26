import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { explorerUrl } from '../../../test-support/explorer-root.mjs';

// Builds WebMeet authInfo the way production does: the sibling Ploinky
// checkout's RouterRequestTokenService mints a router request, its Agent
// verifier checks it as AgentServer does, and the verified grant is normalized
// by authInfoFromInvocation. Importing this module fails if that checkout is
// missing, so listing tests cannot silently fall back to hand-written identities.
const INVOCATION_AUTH_URL = explorerUrl('shared', 'invocation-auth.mjs');
// webmeet_tool.mjs falls back to a path next to Explorer's shared/ directory,
// which does not exist beside this repository; point it at the Explorer checkout.
process.env.PLOINKY_INVOCATION_AUTH_MODULE ||= INVOCATION_AUTH_URL;
const { authInfoFromInvocation } = await import(INVOCATION_AUTH_URL);
// PLOINKY_ROOT overrides the default sibling checkout (the convention of
// Explorer's worker tests), so a run can pin an exact Ploinky revision.
const PLOINKY_ROOT = process.env.PLOINKY_ROOT
    ? pathToFileURL(`${path.resolve(process.env.PLOINKY_ROOT)}/`)
    : new URL('../../../../ploinky/', import.meta.url);
// Ploinky's signer resolves AchillesAgentLib only from an explicit source.
process.env.PLOINKY_AGENTLIB_DIR ||= fileURLToPath(new URL('node_modules/achillesAgentLib', PLOINKY_ROOT));
const { RouterRequestTokenService } = await import(new URL('cli/server/security/tokens/RouterRequestTokenService.js', PLOINKY_ROOT).href);
const { verifyRouterRequestFromHeaders } = await import(new URL('Agent/lib/invocationAuth.mjs', PLOINKY_ROOT).href);
const { computeRchTool } = await import(new URL('Agent/lib/requestHash.mjs', PLOINKY_ROOT).href);

const WEBMEET_ID = 'agent:webmeet/webmeetAgent';
const WEBMEET_SECRET = Buffer.alloc(32, 9);
const minter = new RouterRequestTokenService({ resolveAgentSecret: () => WEBMEET_SECRET });

async function verifiedGrant(claims, tool) {
    const rch = computeRchTool({ method: 'POST', path: '/mcp', tool, arguments: {} });
    const { token } = await minter.mintWithPayload({ targetAgentId: WEBMEET_ID, method: 'POST', path: '/mcp', tool, rch, ...claims });
    const verified = verifyRouterRequestFromHeaders({ authorization: `Bearer ${token}` }, {
        env: { PLOINKY_AGENT_ID: WEBMEET_ID, PLOINKY_AGENT_SECRET: WEBMEET_SECRET.toString('hex') },
        method: 'POST', path: '/mcp', tool, rch,
    });
    if (!verified.ok) throw new Error(`fixture grant failed verification: ${verified.reason}`);
    return verified;
}

async function verifiedAuthInfo(claims, tool) {
    const verified = await verifiedGrant(claims, tool);
    return authInfoFromInvocation(verified.payload, { invocationToken: verified.rawToken });
}

function directUserClaims({ id, roles = ['user'], capabilities, scope, displayName }) {
    const subject = `user:${id}`;
    const lowered = roles.map((role) => String(role).trim().toLowerCase());
    return {
        sub: subject,
        actor: { kind: lowered.includes('guest') ? 'guest' : 'user', id: subject, roles, capabilities, ...(displayName ? { displayName } : {}) },
        ...(scope ? { scope } : {}),
    };
}

// The tool envelope AgentServer hands a tool process or worker after
// requireVerifiedInvocation: the verified grant plus the raw router token.
export async function directUserEnvelope({ tool = 'webmeet_room_list', input = {}, ...principal }) {
    const verified = await verifiedGrant(directUserClaims(principal), tool);
    return {
        tool,
        input,
        metadata: {
            invocation: verified.payload,
            invocationToken: verified.rawToken,
            requestInfo: { headers: { authorization: `Bearer ${verified.rawToken}` } },
        },
    };
}

// A direct browser user, as the Router mints it from the session user.
export async function directUserAuth({ tool = 'webmeet_room_list', ...principal }) {
    return verifiedAuthInfo(directUserClaims(principal), tool);
}

// A delegated agent call carrying a user's claims, as the Router mints it.
export async function delegatedUserAuth({ agentId, user, tool = 'webmeet_room_list' }) {
    return verifiedAuthInfo({
        sub: agentId,
        actor: { kind: 'agent', id: agentId, roles: [] },
        caller: { kind: 'agent', id: agentId, roles: ['agent'] },
        usr: user,
        delegation: { jti: 'fixture-delegation', scope: ['webmeet:rooms:list'], sourceAgentId: agentId },
    }, tool);
}

export const PRINCIPALS = Object.freeze({
    admin: { id: 'owner-1', roles: ['admin'], capabilities: ['explorer.access'] },
    explorerUser: { id: 'member-1', roles: ['user'], capabilities: ['explorer.access'] },
    selfRegistered: { id: 'self-1', roles: ['selfRegistered'], capabilities: ['selfregistered.dashboard.access'] },
    namedAdmin: { id: 'local:admin', roles: ['user'], capabilities: [] },
    adminGuest: { id: 'owner-2', roles: ['admin', 'guest'], capabilities: ['explorer.access'] },
});
