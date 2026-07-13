const ASSIGNMENT_PATTERN = /([A-Za-z0-9_.%~-]{1,80})(?:\\?["'])?\s*(?::|=)/ig;
const MAX_PERCENT_DECODE_PASSES = 64;
const MAX_PERCENT_DECODE_WORK = 64 * 1024;
const MAX_DIAGNOSTIC_NAME_LENGTH = 1024;
const REDACTION_VALUE_PATTERN = /^(?:\[REDACTED\]|<redacted(?:-(?:encoded-string|sdp|ice-candidate|ice-url|private-key|authorization|jwt|sensitive-string|userinfo))?>)(?=$|\\?(?:["']|[nrt])|[\s&,;#}\]])/i;
const EXACT_SENSITIVE_NAMES = new Set([
    'apikey',
    'authorization',
    'cookie',
    'credential',
    'credentials',
    'icepwd',
    'iceufrag',
    'joinrequest',
    'jwt',
    'key',
    'password',
    'passwd',
    'proxyauthorization',
    'sdp',
    'secret',
    'setcookie',
    'sig',
    'signature',
    'token',
]);

function decodeEscapedCodePoints(value) {
    return value.replace(
        /\\+(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2}))/gi,
        (match, bracedUnicode, unicode, hexadecimal) => {
            const codePoint = Number.parseInt(bracedUnicode || unicode || hexadecimal, 16);
            return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
        }
    );
}

function decodeLegacyPercentUnicode(value) {
    return value.replace(
        /%u([0-9a-f]{4})/gi,
        (_match, unicode) => String.fromCodePoint(Number.parseInt(unicode, 16))
    );
}

function buildDetectionViews(value) {
    const views = [value];
    let decoded = value;
    let work = 0;
    for (
        let pass = 0;
        /%[0-9a-f]{2}|%u[0-9a-f]{4}|\\+(?:u(?:[0-9a-f]{4}|\{[0-9a-f]{1,6}\})|x[0-9a-f]{2})/i.test(decoded);
        pass += 1
    ) {
        if (pass >= MAX_PERCENT_DECODE_PASSES || work + decoded.length > MAX_PERCENT_DECODE_WORK) {
            return { views, converged: false };
        }
        work += decoded.length;
        const percentDecoded = decoded.replace(
            /%([0-9a-f]{2})/gi,
            (_match, byte) => String.fromCharCode(Number.parseInt(byte, 16))
        );
        const legacyDecoded = decodeLegacyPercentUnicode(percentDecoded);
        const next = decodeEscapedCodePoints(legacyDecoded);
        if (next === decoded) break;
        decoded = next;
        views.push(decoded);
    }
    return { views, converged: true };
}

export function normalizeDiagnosticName(value) {
    const text = String(value ?? '');
    if (text.length > MAX_DIAGNOSTIC_NAME_LENGTH) return '';
    const detection = buildDetectionViews(text);
    if (!detection.converged) return '';
    return (detection.views.at(-1) || text).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

export function isSensitiveDiagnosticName(value) {
    const text = String(value ?? '');
    if (text.length > MAX_DIAGNOSTIC_NAME_LENGTH) return true;
    const normalized = normalizeDiagnosticName(text);
    if (!normalized && text) return true;
    if (EXACT_SENSITIVE_NAMES.has(normalized)) return true;
    return normalized.endsWith('token')
        || normalized.endsWith('clientsecret')
        || normalized.endsWith('password')
        || normalized.endsWith('privatekey')
        || normalized.endsWith('secret')
        || normalized.endsWith('signingkey')
        || normalized.endsWith('sdp')
        || normalized.endsWith('candidate');
}

function containsSdp(value) {
    const hasSdpVersion = /\bv=0(?:[\r\n]|\\r\\n|\\n)/i.test(value);
    const hasSdpField = /(?:^|[\r\n]|\\r\\n|\\n)(?:o|s|t|m|a)=/i.test(value);
    return hasSdpVersion && hasSdpField;
}

function hasUnredactedSensitiveAssignment(value) {
    ASSIGNMENT_PATTERN.lastIndex = 0;
    for (let match = ASSIGNMENT_PATTERN.exec(value); match; match = ASSIGNMENT_PATTERN.exec(value)) {
        if (!isSensitiveDiagnosticName(match[1])) continue;
        const remainder = value.slice(ASSIGNMENT_PATTERN.lastIndex).replace(/^(?:\s|\\?["'])+/, '');
        if (!remainder || REDACTION_VALUE_PATTERN.test(remainder)) continue;
        return true;
    }
    return false;
}

export function findSensitiveDiagnosticKinds(value) {
    const text = String(value ?? '');
    const detection = buildDetectionViews(text);
    if (!detection.converged) return ['ENCODED_INPUT_OVER_BUDGET'];

    const kinds = new Set();
    for (const detectionView of detection.views) {
        if (containsSdp(detectionView)) kinds.add('SDP');
        if (/\b(?:a=)?candidate:[^\r\n]*/i.test(detectionView)) kinds.add('ICE_CANDIDATE');
        if (/\b(?:turns?|stuns?):[^\s"'<>]+/i.test(detectionView)) kinds.add('ICE_URL');
        if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----/i.test(detectionView)) kinds.add('PRIVATE_KEY');
        if (/\bAuthorization\s*:\s*(?:Bearer|Basic)\s+/i.test(detectionView)) kinds.add('AUTHORIZATION');
        if (/\bBearer\s+(?:"|'|\\?"|\\?'|[A-Za-z0-9_-])/i.test(detectionView)) kinds.add('AUTHORIZATION');
        if (/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/i.test(detectionView)) kinds.add('JWT');
    }
    const decodedView = detection.views.at(-1) || text;
    if (hasUnredactedSensitiveAssignment(decodedView)) kinds.add('SENSITIVE_ASSIGNMENT');
    if (/\b(?:https?|wss?):\/\/(?!<redacted-userinfo>@)[^\s/@]+@/i.test(decodedView)) {
        kinds.add('URL_USERINFO');
    }
    return [...kinds];
}

export function redactSensitiveString(value) {
    const text = String(value);
    const kinds = findSensitiveDiagnosticKinds(text);
    if (kinds.includes('ENCODED_INPUT_OVER_BUDGET')) return '<redacted-encoded-string>';
    if (kinds.includes('SDP')) return '<redacted-sdp>';
    if (kinds.includes('ICE_CANDIDATE')) return '<redacted-ice-candidate>';
    if (kinds.includes('ICE_URL')) return '<redacted-ice-url>';
    if (kinds.includes('PRIVATE_KEY')) return '<redacted-private-key>';
    if (kinds.includes('AUTHORIZATION')) return '<redacted-authorization>';
    if (kinds.includes('JWT')) return '<redacted-jwt>';
    if (kinds.includes('SENSITIVE_ASSIGNMENT')) return '<redacted-sensitive-string>';
    return text.replace(
        /\b((?:https?|wss?):\/\/)[^\s/@]+@/gi,
        '$1<redacted-userinfo>@'
    );
}

function isSensitiveKey(key) {
    return isSensitiveDiagnosticName(key);
}

export function redactSensitive(value) {
    if (Array.isArray(value)) {
        return value.map((item) => redactSensitive(item));
    }
    if (typeof value === 'string') {
        return redactSensitiveString(value);
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    const output = {};
    for (const [key, item] of Object.entries(value)) {
        if (isSensitiveKey(key)) {
            output[key] = '<redacted>';
            continue;
        }
        output[key] = redactSensitive(item);
    }
    return output;
}
