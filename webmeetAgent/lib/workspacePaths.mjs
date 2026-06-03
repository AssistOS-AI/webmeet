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
    const dataDir = String(process.env.WEBMEET_DATA_DIR || '').trim() || path.join(ploinkyDir, 'webmeet');
    const webmeetDir = dataDir;
    const jobsDir = path.join(webmeetDir, 'jobs');
    const locksDir = path.join(webmeetDir, 'locks');
    return {
        workspaceRoot,
        ploinkyDir,
        webmeetDir,
        roomsDir: path.join(webmeetDir, 'rooms'),
        meetingsDir: path.join(webmeetDir, 'rooms'),
        resourcesDir: webmeetDir,
        eventsDir: path.join(webmeetDir, 'events'),
        locksDir,
        meetingLocksDir: path.join(locksDir, 'rooms'),
        jobsDir,
        jobsPendingDir: path.join(jobsDir, 'pending'),
        jobsProcessingDir: path.join(jobsDir, 'processing'),
        jobsDoneDir: path.join(jobsDir, 'done'),
        jobsFailedDir: path.join(jobsDir, 'failed')
    };
}
