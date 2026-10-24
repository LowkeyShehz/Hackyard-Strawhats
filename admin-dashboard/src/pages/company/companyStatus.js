/** Attendance status → badge class and label for company views */
export function statusBadge(status) {
    switch (status) {
        case 'auto_approved':
        case 'approved':
            return { className: 'approved', label: 'Verified' };
        case 'pending_review':
            return { className: 'pending', label: 'Under review' };
        case 'rejected':
            return { className: 'rejected', label: 'Rejected' };
        default:
            return { className: 'pending', label: status || '-' };
    }
}

/** ISO timestamp → HH:MM in IST */
export function istTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
        ? '-'
        : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

/** Today's date in IST as YYYY-MM-DD */
export function istToday() {
    return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD shifted by `days` */
export function shiftDate(date, days) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
