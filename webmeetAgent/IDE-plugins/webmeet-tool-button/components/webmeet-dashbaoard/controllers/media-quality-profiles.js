const CAMERA_QUALITY_PROFILES = {
    h360: {
        preset: 'h360',
        resolution: { width: 640, height: 360, frameRate: 24 },
        encoding: { maxBitrate: 800_000, maxFramerate: 24 }
    },
    h540: {
        preset: 'h540',
        resolution: { width: 960, height: 540, frameRate: 30 },
        encoding: { maxBitrate: 1_500_000, maxFramerate: 30 }
    },
    h720: {
        preset: 'h720',
        resolution: { width: 1280, height: 720, frameRate: 30 },
        encoding: { maxBitrate: 2_500_000, maxFramerate: 30 }
    },
    h1080: {
        preset: 'h1080',
        resolution: { width: 1920, height: 1080, frameRate: 30 },
        encoding: { maxBitrate: 4_500_000, maxFramerate: 30 }
    }
};

const SCREEN_SHARE_QUALITY_PROFILES = {
    h720fps15: {
        preset: 'h720fps15',
        resolution: { width: 1280, height: 720, frameRate: 15 },
        encoding: { maxBitrate: 1_500_000, maxFramerate: 15 }
    },
    h720fps30: {
        preset: 'h720fps30',
        resolution: { width: 1280, height: 720, frameRate: 30 },
        encoding: { maxBitrate: 2_500_000, maxFramerate: 30 }
    },
    h1080fps15: {
        preset: 'h1080fps15',
        resolution: { width: 1920, height: 1080, frameRate: 15 },
        encoding: { maxBitrate: 2_500_000, maxFramerate: 15 }
    },
    h1080fps30: {
        preset: 'h1080fps30',
        resolution: { width: 1920, height: 1080, frameRate: 30 },
        encoding: { maxBitrate: 3_500_000, maxFramerate: 30 }
    }
};

function cloneProfile(profile) {
    return {
        preset: profile.preset,
        resolution: { ...profile.resolution },
        encoding: { ...profile.encoding }
    };
}

export function getMediaQualityProfile(type, quality) {
    const profiles = type === 'screen' ? SCREEN_SHARE_QUALITY_PROFILES : CAMERA_QUALITY_PROFILES;
    const fallback = type === 'screen'
        ? SCREEN_SHARE_QUALITY_PROFILES.h1080fps30
        : CAMERA_QUALITY_PROFILES.h720;
    return cloneProfile(profiles[String(quality || '').trim()] || fallback);
}

export function getLiveKitProfileResolution(livekit, type, profile) {
    const presetMap = type === 'screen'
        ? livekit?.ScreenSharePresets
        : livekit?.VideoPresets;
    const preset = presetMap?.[profile?.preset];
    return preset?.resolution || profile?.resolution || {};
}

