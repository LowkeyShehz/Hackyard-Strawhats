import { useState, useEffect } from 'react';

const NARROW = '(max-width: 768px)';

function readFlag(key) {
    try {
        return localStorage.getItem(key) === 'true';
    } catch {
        return false;
    }
}

/**
 * Desktop sidebar collapse state, remembered per browser under `storageKey`.
 * Phones always get the full-width drawer, so collapsed is false there.
 */
export default function useCollapsibleSidebar(storageKey) {
    const [collapsed, setCollapsed] = useState(() => readFlag(storageKey));
    const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);

    useEffect(() => {
        const query = window.matchMedia(NARROW);
        const onChange = (e) => setNarrow(e.matches);
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }, []);

    const toggle = () => {
        setCollapsed((prev) => {
            const next = !prev;
            try {
                localStorage.setItem(storageKey, String(next));
            } catch { /* storage blocked: keep the in-memory state */ }
            return next;
        });
    };

    return [collapsed && !narrow, toggle];
}
