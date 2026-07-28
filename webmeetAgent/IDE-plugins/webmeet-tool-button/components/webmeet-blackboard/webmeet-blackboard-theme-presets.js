export const DEFAULT_BLACKBOARD_THEME_ID = 'classic';

const blackboardThemePresets = [
    {
        id: DEFAULT_BLACKBOARD_THEME_ID,
        label: 'Classic',
        tokens: {
            panelBackground: '#f7f8fb',
            boardBackground: '#ffffff',
            boardGridColor: '#eef2f7',
            boardBorder: '#d6deea',
            widgetSurface: '#ffffff',
            widgetText: '#172033',
            widgetBorder: '#cbd5e1',
            selectionColor: '#2563eb',
            selectionShadow: 'rgba(37, 99, 235, 0.18)',
            resizeHandleSurface: '#ffffff',
            inlineEditBackground: 'rgba(37, 99, 235, 0.08)',
            contextButtonSurface: '#ffffff',
            contextButtonHoverSurface: '#f8fafc',
            contextButtonText: '#172033',
            danger: '#dc2626'
        },
        defaults: {
            shape: {fill: '#ffffff', stroke: '#334155', strokeWidth: 2},
            line: {stroke: '#334155', strokeWidth: 1},
            text: {fill: 'transparent', stroke: '#cbd5e1', textColor: '#172033'},
            image: {fill: 'transparent', stroke: '#334155', strokeWidth: 0}
        }
    },
    {
        id: 'slate',
        label: 'Slate',
        tokens: {
            panelBackground: '#111827',
            boardBackground: '#1f2937',
            boardGridColor: '#374151',
            boardBorder: '#4b5563',
            widgetSurface: '#f9fafb',
            widgetText: '#111827',
            widgetBorder: '#94a3b8',
            selectionColor: '#38bdf8',
            selectionShadow: 'rgba(56, 189, 248, 0.28)',
            resizeHandleSurface: '#e0f2fe',
            inlineEditBackground: 'rgba(56, 189, 248, 0.14)',
            contextButtonSurface: '#f9fafb',
            contextButtonHoverSurface: '#e0f2fe',
            contextButtonText: '#111827',
            danger: '#ef4444'
        },
        defaults: {
            shape: {fill: '#e0f2fe', stroke: '#38bdf8', strokeWidth: 2},
            line: {stroke: '#38bdf8', strokeWidth: 1},
            text: {fill: 'transparent', stroke: '#38bdf8', textColor: '#e0f2fe'},
            image: {fill: 'transparent', stroke: '#38bdf8', strokeWidth: 0}
        }
    },
    {
        id: 'paper',
        label: 'Paper',
        tokens: {
            panelBackground: '#f3f4f6',
            boardBackground: '#fffdf7',
            boardGridColor: '#e8dcc4',
            boardBorder: '#d8c7a6',
            widgetSurface: '#ffffff',
            widgetText: '#1f2937',
            widgetBorder: '#b8a47f',
            selectionColor: '#0f766e',
            selectionShadow: 'rgba(15, 118, 110, 0.22)',
            resizeHandleSurface: '#ffffff',
            inlineEditBackground: 'rgba(15, 118, 110, 0.1)',
            contextButtonSurface: '#ffffff',
            contextButtonHoverSurface: '#f0fdfa',
            contextButtonText: '#1f2937',
            danger: '#b91c1c'
        },
        defaults: {
            shape: {fill: '#fff7df', stroke: '#7c6f57', strokeWidth: 2},
            line: {stroke: '#7c6f57', strokeWidth: 1},
            text: {fill: 'transparent', stroke: '#b8a47f', textColor: '#5f4b24'},
            image: {fill: 'transparent', stroke: '#7c6f57', strokeWidth: 0}
        }
    },
    {
        id: 'mint',
        label: 'Mint',
        tokens: {
            panelBackground: '#ecfdf5',
            boardBackground: '#f7fffb',
            boardGridColor: '#bbf7d0',
            boardBorder: '#86efac',
            widgetSurface: '#ffffff',
            widgetText: '#052e16',
            widgetBorder: '#16a34a',
            selectionColor: '#0f766e',
            selectionShadow: 'rgba(15, 118, 110, 0.2)',
            resizeHandleSurface: '#ffffff',
            inlineEditBackground: 'rgba(15, 118, 110, 0.1)',
            contextButtonSurface: '#ffffff',
            contextButtonHoverSurface: '#dcfce7',
            contextButtonText: '#052e16',
            danger: '#dc2626'
        },
        defaults: {
            shape: {fill: '#dcfce7', stroke: '#16a34a', strokeWidth: 2},
            line: {stroke: '#16a34a', strokeWidth: 1},
            text: {fill: 'transparent', stroke: '#16a34a', textColor: '#166534'},
            image: {fill: 'transparent', stroke: '#16a34a', strokeWidth: 0}
        }
    },
    {
        id: 'leadership',
        label: 'Leadership',
        tokens: {
            panelBackground: '#e2dedd',
            boardBackground: '#f4f2f1',
            boardGridColor: '#d8d6d5',
            boardBorder: '#a8aaaa',
            widgetSurface: '#ffffff',
            widgetText: '#1f2328',
            widgetBorder: '#5d9cac',
            selectionColor: '#6276b7',
            selectionShadow: 'rgba(98, 118, 183, 0.26)',
            resizeHandleSurface: '#f4f2f1',
            inlineEditBackground: 'rgba(124, 194, 204, 0.16)',
            contextButtonSurface: '#ffffff',
            contextButtonHoverSurface: '#e8f5f5',
            contextButtonText: '#1f2328',
            danger: '#b91c1c'
        },
        defaults: {
            shape: {fill: '#d7eef0', stroke: '#5d9cac', strokeWidth: 2},
            line: {stroke: '#6276b7', strokeWidth: 1},
            text: {fill: 'transparent', stroke: '#91c9c8', textColor: '#315f86'},
            image: {fill: 'transparent', stroke: '#5d9cac', strokeWidth: 0}
        }
    },
    {
        id: 'contrast',
        label: 'High contrast',
        tokens: {
            panelBackground: '#000000',
            boardBackground: '#000000',
            boardGridColor: '#27272a',
            boardBorder: '#ffffff',
            widgetSurface: '#ffffff',
            widgetText: '#ffffff',
            widgetBorder: '#ffffff',
            selectionColor: '#facc15',
            selectionShadow: 'rgba(250, 204, 21, 0.45)',
            resizeHandleSurface: '#facc15',
            inlineEditBackground: 'rgba(250, 204, 21, 0.22)',
            contextButtonSurface: '#ffffff',
            contextButtonHoverSurface: '#facc15',
            contextButtonText: '#000000',
            danger: '#ef4444'
        },
        defaults: {
            shape: {fill: '#facc15', stroke: '#ffffff', strokeWidth: 3},
            line: {stroke: '#facc15', strokeWidth: 1},
            text: {fill: 'transparent', stroke: '#facc15', textColor: '#ffffff'},
            image: {fill: 'transparent', stroke: '#ffffff', strokeWidth: 0}
        }
    }
];

const themeById = new Map(blackboardThemePresets.map((theme) => [theme.id, theme]));

export function getBlackboardThemeOptions() {
    return blackboardThemePresets.map(({id, label}) => ({id, label}));
}

export function getBlackboardTheme(themeId = DEFAULT_BLACKBOARD_THEME_ID) {
    return themeById.get(String(themeId || '').trim()) || themeById.get(DEFAULT_BLACKBOARD_THEME_ID);
}

export function resolveBlackboardThemeId(metadata = {}) {
    const themeId = metadata?.theme?.id || metadata?.themeId || DEFAULT_BLACKBOARD_THEME_ID;
    return getBlackboardTheme(themeId).id;
}

export function resolveBlackboardTheme(metadata = {}) {
    return getBlackboardTheme(resolveBlackboardThemeId(metadata));
}
