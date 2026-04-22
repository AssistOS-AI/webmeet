import fs from 'node:fs';
import path from 'node:path';

function resolveStartDir(startDir = '') {
    const explicit = String(startDir || '').trim();
    if (explicit) {
        return explicit;
    }
    return String(
        process.env.PLOINKY_WORKSPACE_ROOT
        || process.env.WORKSPACE_ROOT
        || process.env.PLOINKY_CWD
        || process.env.ASSISTOS_FS_ROOT
        || process.cwd()
    ).trim();
}

export function findWorkspaceRoot(startDir = '') {
    let current = path.resolve(resolveStartDir(startDir));
    while (true) {
        if (fs.existsSync(path.join(current, '.ploinky'))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return path.resolve(resolveStartDir(startDir));
        }
        current = parent;
    }
}

export function getWorkspacePaths(startDir = '') {
    const workspaceRoot = findWorkspaceRoot(startDir);
    const ploinkyDir = path.join(workspaceRoot, '.ploinky');
    const webmeetDir = path.join(ploinkyDir, 'webmeet');
    const jobsDir = path.join(webmeetDir, 'jobs');
    return {
        workspaceRoot,
        ploinkyDir,
        webmeetDir,
        workspacesDir: path.join(webmeetDir, 'workspaces'),
        channelsDir: path.join(webmeetDir, 'channels'),
        meetingsDir: path.join(webmeetDir, 'meetings'),
        eventsDir: path.join(webmeetDir, 'events'),
        jobsDir,
        jobsPendingDir: path.join(jobsDir, 'pending'),
        jobsProcessingDir: path.join(jobsDir, 'processing'),
        jobsDoneDir: path.join(jobsDir, 'done'),
        jobsFailedDir: path.join(jobsDir, 'failed')
    };
}
