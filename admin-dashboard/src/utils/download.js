import api from './api';

/**
 * Download a file from an authenticated API endpoint (the browser cannot attach the Bearer
 * token to a plain link, so fetch it and save the blob).
 */
export async function downloadFile(url, fallbackName) {
    const res = await api.get(url);
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
    }
    const disposition = res.headers.get('Content-Disposition') || '';
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] || fallbackName;
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
}
