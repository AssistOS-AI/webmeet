import { findWorkspaceRoot } from '../lib/workspacePaths.mjs';

const AXIFACE_REPO_NAME = 'AxiFace';
const PUBLIC_PREFIX = '/axi-face/';

async function pathExists(fs, targetPath) {
    try {
        await fs.stat(targetPath);
        return true;
    } catch {
        return false;
    }
}

function getContentType(filePath) {
    const extension = filePath.split('.').pop()?.toLowerCase() || '';
    switch (extension) {
        case 'css':
            return 'text/css; charset=utf-8';
        case 'js':
        case 'mjs':
            return 'text/javascript; charset=utf-8';
        case 'json':
            return 'application/json; charset=utf-8';
        case 'svg':
            return 'image/svg+xml; charset=utf-8';
        case 'html':
            return 'text/html; charset=utf-8';
        default:
            return 'application/octet-stream';
    }
}

async function buildAxiFacePackIndex({ fs, path, root }) {
    const packsRoot = path.join(root, 'packs');
    const entries = await fs.readdir(packsRoot, { withFileTypes: true }).catch(() => []);
    const packs = [];
    for (const entry of entries) {
        if (!entry?.isDirectory?.()) continue;
        const id = String(entry.name || '').trim();
        if (!id) continue;
        try {
            const manifest = JSON.parse(await fs.readFile(path.join(packsRoot, id, 'manifest.json'), 'utf8'));
            packs.push({
                id: String(manifest.id || id),
                label: String(manifest.label || manifest.name || manifest.id || id),
                type: String(manifest.type || ''),
                defaultEmotion: String(manifest.defaultEmotion || ''),
                emotions: manifest.emotions && typeof manifest.emotions === 'object'
                    ? Object.keys(manifest.emotions).sort()
                    : [],
                manifestSrc: `/axi-face/packs/${encodeURIComponent(id)}/manifest.json`
            });
        } catch {
            // Ignore malformed or unreadable pack manifests.
        }
    }
    return { ok: true, packs: packs.sort((left, right) => left.label.localeCompare(right.label)) };
}

export async function resolveAxiFaceRepoRoot({ fs, path, workspaceRoot = '' } = {}) {
    const candidates = [
        String(process.env.AXIFACE_REPO_PATH || '').trim(),
        path.join(workspaceRoot || findWorkspaceRoot(), '.ploinky', 'repos', AXIFACE_REPO_NAME)
    ].filter(Boolean);

    for (const candidate of candidates) {
        const root = path.resolve(candidate);
        if (await pathExists(fs, path.join(root, 'src', 'axi-face.mjs'))) {
            return root;
        }
    }

    throw new Error('AxiFace repository is unavailable. Configure AXIFACE_REPO_PATH or enable the AxiFace workspace repo.');
}

export function createAxiFaceAssetsHttpHandler({ fs, path, workspaceRoot = '' }) {
    let rootPromise = null;

    return async function handleAxiFaceAssetsHttpRequest(req, res, parsedUrl) {
        const pathname = parsedUrl.pathname || '/';
        if (req.method !== 'GET' || !pathname.startsWith(PUBLIC_PREFIX)) {
            return false;
        }

        try {
            if (!rootPromise) {
                rootPromise = resolveAxiFaceRepoRoot({ fs, path, workspaceRoot });
            }
            const root = await rootPromise;
            const relativePath = decodeURIComponent(pathname.slice(PUBLIC_PREFIX.length)).replace(/^\/+/, '');
            if (!relativePath || relativePath.includes('\0')) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return true;
            }
            if (relativePath === 'packs/index.json') {
                const payload = await buildAxiFacePackIndex({ fs, path, root });
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-cache'
                });
                res.end(JSON.stringify(payload));
                return true;
            }
            const filePath = path.resolve(root, relativePath);
            const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
            if (filePath !== root && !filePath.startsWith(rootWithSeparator)) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('Forbidden');
                return true;
            }
            const content = await fs.readFile(filePath);
            res.writeHead(200, {
                'Content-Type': getContentType(filePath),
                'Cache-Control': 'no-cache'
            });
            res.end(content);
            return true;
        } catch (error) {
            const status = error?.code === 'ENOENT' ? 404 : 500;
            res.writeHead(status, { 'Content-Type': 'text/plain' });
            res.end(status === 404 ? 'Not Found' : 'AxiFace asset service failed.');
            return true;
        }
    };
}
