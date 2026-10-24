import React, { useState, useEffect, useCallback } from 'react';
import api from '../utils/api';
import { notifyReviewQueueChanged, networkErrorMessage } from '../utils/events';

const PAGE_LIMIT = 50;

/** Stable id for a queue item: backend sends log_id = `${worker_id}#${log_date}` (older backends omit it). */
function logIdOf(item) {
    return item.log_id || `${item.worker_id}#${item.log_date}`;
}

function getConfidenceClass(c, label) {
    const threshold = label === 'Face' ? 80 : 60;
    if (c >= threshold) return 'high';
    if (c >= threshold - 20) return 'medium';
    return 'low';
}

function SignalConfidence({ label, value }) {
    const has = typeof value === 'number' && !Number.isNaN(value);
    const pct = has ? Math.max(0, Math.min(100, Math.round(value))) : 0;
    const isLow = has && getConfidenceClass(pct, label) === 'low';

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', marginBottom: '3px', color: isLow ? 'var(--danger)' : 'inherit', fontWeight: isLow ? 'bold' : 'normal' }}>
            <span style={{ width: '38px', color: isLow ? 'var(--danger)' : 'var(--text-muted)' }}>{label}</span>
            <div className="confidence-bar">
                <div className={`confidence-fill ${getConfidenceClass(pct, label)}`} style={{ width: `${pct}%` }} />
            </div>
            <span style={{ minWidth: '32px', textAlign: 'right' }}>{has ? `${pct}%` : '-'}</span>
        </div>
    );
}

function ReasonBadge({ reason }) {
    let type = 'default';
    if (reason.toLowerCase().includes('face')) type = 'danger';
    else if (reason.toLowerCase().includes('geo') || reason.toLowerCase().includes('location') || reason.toLowerCase().includes('site')) type = 'warning';
    else if (reason.toLowerCase().includes('voice') || reason.toLowerCase().includes('audio')) type = 'warning';

    return (
        <span style={{
            display: 'inline-block', padding: '3px 8px', margin: '2px 2px 4px 0', borderRadius: '12px', fontSize: '11px',
            backgroundColor: type === 'danger' ? 'rgba(220, 53, 69, 0.1)' : type === 'warning' ? 'rgba(255, 193, 7, 0.1)' : 'rgba(0,0,0,0.05)',
            color: type === 'danger' ? 'var(--danger)' : type === 'warning' ? '#b8860b' : 'var(--text-secondary)',
            border: `1px solid ${type === 'danger' ? 'rgba(220, 53, 69, 0.3)' : type === 'warning' ? 'rgba(255, 193, 7, 0.3)' : '#ddd'}`,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '240px', cursor: 'help'
        }} title={reason}>
            {reason}
        </span>
    );
}

export default function ReviewQueue() {
    const [reviews, setReviews] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [notice, setNotice] = useState('');
    const [rowErrors, setRowErrors] = useState({});
    
    // Modal states
    const [selectedLog, setSelectedLog] = useState(null);
    const [modalError, setModalError] = useState('');
    const [justification, setJustification] = useState('');
    const [processingId, setProcessingId] = useState(null);
    const [viewingImages, setViewingImages] = useState(null); // stores the log object for side-by-side view

    // Bulk action states
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [bulkProcessing, setBulkProcessing] = useState(false);

    const fetchReviews = useCallback(async () => {
        setLoading(true);
        setLoadError('');
        try {
            const res = await api.get(`/api/admin/review-queue?limit=${PAGE_LIMIT}`);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            const data = await res.json();
            setReviews(data.items || []);
            setRowErrors({});
            setSelectedIds(new Set());
        } catch (err) {
            setLoadError(networkErrorMessage(err, 'Could not reach the server. Check your connection.'));
        }
        setLoading(false);
    }, []);

    useEffect(() => { fetchReviews(); }, [fetchReviews]);

    function removeRow(id) {
        setReviews(prev => prev.filter(r => logIdOf(r) !== id));
        setRowErrors(prev => { const next = { ...prev }; delete next[id]; return next; });
        setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    }

    async function handleDecision(item, decision, customJustification = '') {
        const id = logIdOf(item);
        setProcessingId(id);
        setRowErrors(prev => ({ ...prev, [id]: '' }));
        setModalError('');
        setNotice('');

        let outcome = 'error';
        let message = '';
        try {
            const res = await api.put(`/api/admin/review/${encodeURIComponent(id)}`, {
                action: decision,
                justification: customJustification || justification || (decision === 'approve' ? 'Approved by admin' : ''),
                workerId: item.worker_id,
                logDate: item.log_date,
            });
            if (res.ok) {
                outcome = 'ok';
            } else {
                const err = await res.json().catch(() => ({}));
                if (res.status === 409) {
                    outcome = 'stale';
                    message = `${item.worker_name || item.worker_id} (${item.log_date}) was already reviewed — removed from the queue.`;
                } else if (res.status === 404) {
                    outcome = 'stale';
                    message = `${item.worker_name || item.worker_id} (${item.log_date}): attendance log not found — removed from the queue.`;
                } else {
                    message = err.error || `Request failed (HTTP ${res.status})`;
                }
            }
        } catch (err) {
            message = networkErrorMessage(err);
        }

        if (outcome === 'ok' || outcome === 'stale') {
            removeRow(id);
            setSelectedLog(null);
            setJustification('');
            if (outcome === 'stale') setNotice(message);
            notifyReviewQueueChanged();
        } else {
            setRowErrors(prev => ({ ...prev, [id]: `${decision === 'approve' ? 'Approve' : 'Reject'} failed: ${message}` }));
            if (selectedLog) setModalError(message);
        }
        setProcessingId(null);
        return outcome === 'ok' || outcome === 'stale';
    }

    async function handleBulkApprove() {
        setBulkProcessing(true);
        const ids = Array.from(selectedIds);
        let successCount = 0;

        for (const id of ids) {
            const item = reviews.find(r => logIdOf(r) === id);
            if (!item) continue;
            
            const success = await handleDecision(item, 'approve', 'Bulk approved by admin');
            if (success) successCount++;
        }
        
        setBulkProcessing(false);
        setNotice(`Bulk approval finished. ${successCount} items approved.`);
    }

    function toggleAll(e) {
        if (e.target.checked) setSelectedIds(new Set(reviews.map(logIdOf)));
        else setSelectedIds(new Set());
    }

    function toggleOne(id) {
        const next = new Set(selectedIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelectedIds(next);
    }

    if (loading && reviews.length === 0 && !loadError) {
        return <div style={{ padding: '40px', color: 'var(--text-muted)' }}>Loading review queue...</div>;
    }

    return (
        <div>
            <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                    <h2>Review Queue</h2>
                    <p>Flagged attendance logs requiring admin review — {reviews.length} items pending</p>
                    {reviews.length >= PAGE_LIMIT && (
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                            Showing the first {reviews.length} items. Review these to load more.
                        </p>
                    )}
                </div>
                {selectedIds.size > 0 && (
                    <div style={{ background: 'var(--surface-color)', padding: '12px 20px', borderRadius: '8px', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '16px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                        <span style={{ fontWeight: 'bold' }}>{selectedIds.size} selected</span>
                        <button className="btn btn-success" disabled={bulkProcessing} onClick={handleBulkApprove}>
                            {bulkProcessing ? 'Processing...' : 'Approve Selected'}
                        </button>
                    </div>
                )}
            </div>

            {loadError && (
                <div className="card" style={{ marginBottom: '16px', borderLeft: '4px solid var(--danger)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                    <span style={{ color: 'var(--danger)', fontSize: '14px' }}>Could not load the review queue: {loadError}</span>
                    <button className="btn btn-outline btn-sm" onClick={fetchReviews}>Retry</button>
                </div>
            )}

            {notice && (
                <div className="card" role="status" style={{ marginBottom: '16px', borderLeft: '4px solid var(--warning)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                    <span style={{ fontSize: '14px' }}>{notice}</span>
                    <button className="btn btn-outline btn-sm" onClick={() => setNotice('')}>Dismiss</button>
                </div>
            )}

            <div className="card">
                <div className="table-container">
                    <table style={{ minWidth: '900px' }}>
                        <thead>
                            <tr>
                                <th style={{ width: '40px' }}>
                                    <input type="checkbox" checked={selectedIds.size === reviews.length && reviews.length > 0} onChange={toggleAll} disabled={reviews.length === 0 || bulkProcessing} />
                                </th>
                                <th>Worker</th>
                                <th>Date</th>
                                <th>Site</th>
                                <th>Confidence</th>
                                <th>Flagged Reason</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {reviews.map(log => {
                                const key = logIdOf(log);
                                const reason = log.flagged_reason || log.review_reason;
                                const isSelected = selectedIds.has(key);
                                return (
                                    <tr key={key} style={{ backgroundColor: isSelected ? 'rgba(var(--primary-rgb), 0.05)' : 'transparent' }}>
                                        <td>
                                            <input type="checkbox" checked={isSelected} onChange={() => toggleOne(key)} disabled={bulkProcessing || processingId === key} />
                                        </td>
                                        <td>
                                            <div>
                                                <strong>{log.worker_name}</strong>
                                                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{log.worker_id}</div>
                                                {log.worker_phone && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{log.worker_phone}</div>}
                                            </div>
                                        </td>
                                        <td>{log.log_date}</td>
                                        <td>{log.site_name || '-'}</td>
                                        <td style={{ minWidth: '170px' }}>
                                            <SignalConfidence label="Face" value={log.face_confidence} />
                                            <SignalConfidence label="GPS" value={log.geo_confidence} />
                                            <SignalConfidence label="Voice" value={log.voice_confidence} />
                                        </td>
                                        <td style={{ maxWidth: '280px' }}>
                                            <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap' }}>
                                            {reason
                                                ? reason.split(' | ').map((r, i) => <ReasonBadge key={i} reason={r} />)
                                                : <span style={{ color: 'var(--text-muted)' }}>-</span>}
                                            </div>
                                            {(log.enrolled_image_url || log.checkin_image_url) && (
                                                <button className="btn btn-outline btn-sm" style={{ marginTop: '8px', fontSize: '11px', padding: '4px 8px' }} onClick={() => setViewingImages(log)}>
                                                    🖼️ View Selfies
                                                </button>
                                            )}
                                        </td>
                                        <td>
                                            <div style={{ display: 'flex', gap: '6px' }}>
                                                {processingId === key ? (
                                                    <span style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '4px 8px' }}>Processing...</span>
                                                ) : (
                                                    <>
                                                        <button className="btn btn-success btn-sm" disabled={!!processingId || bulkProcessing} onClick={() => handleDecision(log, 'approve')}>Approve</button>
                                                        <button className="btn btn-danger btn-sm" disabled={!!processingId || bulkProcessing} onClick={() => { setModalError(''); setSelectedLog(log); }}>Reject</button>
                                                    </>
                                                )}
                                            </div>
                                            {rowErrors[key] && (
                                                <div role="alert" style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '6px', maxWidth: '220px' }}>
                                                    {rowErrors[key]}
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                            {reviews.length === 0 && !loadError && (
                                <tr><td colSpan="7" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>No items pending review</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Rejection Modal */}
            {selectedLog && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
                    <div className="card" style={{ width: '400px', maxWidth: 'calc(100vw - 32px)' }}>
                        <h3 style={{ marginBottom: '12px' }}>Rejection Justification</h3>
                        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>Provide a reason for rejection (required for audit trail):</p>
                        <textarea className="search-input" style={{ width: '100%', height: '80px', resize: 'vertical' }}
                            value={justification} onChange={e => setJustification(e.target.value)}
                            placeholder="e.g., Face does not match registered photo..." />
                        {modalError && (
                            <p role="alert" style={{ fontSize: '13px', color: 'var(--danger)', marginTop: '8px' }}>Reject failed: {modalError}</p>
                        )}
                        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
                            <button className="btn btn-outline btn-sm" disabled={!!processingId} onClick={() => { setSelectedLog(null); setJustification(''); setModalError(''); }}>Cancel</button>
                            <button className="btn btn-danger btn-sm" disabled={!justification.trim() || !!processingId} onClick={() => handleDecision(selectedLog, 'reject')}>
                                {processingId ? 'Processing...' : 'Confirm Rejection'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Image Viewer Modal */}
            {viewingImages && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 1050 }}>
                    <div style={{ width: '90%', maxWidth: '800px', background: 'var(--bg-color)', borderRadius: '12px', padding: '24px', position: 'relative' }}>
                        <button style={{ position: 'absolute', top: '16px', right: '16px', background: 'transparent', border: 'none', fontSize: '24px', cursor: 'pointer', color: 'var(--text-color)' }} onClick={() => setViewingImages(null)}>×</button>
                        
                        <h3 style={{ marginBottom: '20px', textAlign: 'center' }}>Face Verification: {viewingImages.worker_name}</h3>
                        
                        <div style={{ display: 'flex', gap: '24px', justifyContent: 'center', flexWrap: 'wrap' }}>
                            <div style={{ flex: '1 1 300px', maxWidth: '350px', textAlign: 'center' }}>
                                <h4 style={{ marginBottom: '12px', color: 'var(--text-secondary)' }}>Enrolled Selfie</h4>
                                <div style={{ width: '100%', aspectRatio: '3/4', backgroundColor: '#f0f0f0', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    {viewingImages.enrolled_image_url ? 
                                        <img src={viewingImages.enrolled_image_url} alt="Enrolled Selfie" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : 
                                        <span style={{ color: '#999' }}>Image Not Available</span>
                                    }
                                </div>
                            </div>
                            
                            <div style={{ flex: '1 1 300px', maxWidth: '350px', textAlign: 'center' }}>
                                <h4 style={{ marginBottom: '12px', color: 'var(--text-secondary)' }}>Today's Check-in</h4>
                                <div style={{ 
                                    width: '100%', aspectRatio: '3/4', backgroundColor: '#f0f0f0', borderRadius: '8px', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    border: `3px solid ${viewingImages.face_confidence >= 80 ? 'var(--success)' : 'var(--danger)'}`,
                                    position: 'relative'
                                }}>
                                    {viewingImages.checkin_image_url ? 
                                        <img src={viewingImages.checkin_image_url} alt="Today's Check-in" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : 
                                        <span style={{ color: '#999' }}>Image Not Available</span>
                                    }
                                    <div style={{
                                        position: 'absolute', bottom: 0, left: 0, right: 0, padding: '8px', fontWeight: 'bold',
                                        backgroundColor: viewingImages.face_confidence >= 80 ? 'rgba(40,167,69,0.85)' : 'rgba(220,53,69,0.85)',
                                        color: '#fff', textAlign: 'center'
                                    }}>
                                        Match Score: {typeof viewingImages.face_confidence === 'number' ? `${Math.round(viewingImages.face_confidence)}%` : 'N/A'}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'center', gap: '16px', marginTop: '24px' }}>
                            <button className="btn btn-outline" onClick={() => setViewingImages(null)}>Close</button>
                            <button className="btn btn-success" onClick={() => { handleDecision(viewingImages, 'approve'); setViewingImages(null); }}>Approve</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
