import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../utils/api';
import { networkErrorMessage } from '../utils/events';

const LANGUAGE_MAP = { hi: 'Hindi', en: 'English', te: 'Telugu', ta: 'Tamil', bn: 'Bengali', gu: 'Gujarati', kn: 'Kannada', ml: 'Malayalam', mr: 'Marathi' };
const DEFAULT_THRESHOLD = 90;

// The certificate threshold comes from the dashboard API; fetch it once per session.
let thresholdPromise = null;
function fetchCertificateThreshold() {
    if (!thresholdPromise) {
        thresholdPromise = api.get('/api/admin/dashboard')
            .then(res => (res.ok ? res.json() : {}))
            .then(data => (typeof data.certificateThreshold === 'number' && data.certificateThreshold > 0
                ? data.certificateThreshold
                : DEFAULT_THRESHOLD))
            .catch(() => {
                thresholdPromise = null; // allow a retry on the next mount
                return DEFAULT_THRESHOLD;
            });
    }
    return thresholdPromise;
}

/** Normalise the list row / profile response into one shape. */
function normaliseWorker(w = {}) {
    return {
        ...w,
        total_days_logged: Number(w.total_days_logged) || 0,
        aadhaar_verified: w.aadhaar_verified ?? !!w.aadhaar_last4,
        selfie_verified: w.selfie_verified ?? !!w.face_vector,
    };
}

function extractAttendance(data) {
    const logs = data.attendanceLogs || data.attendance_logs || data.attendanceHistory
        || data.attendance_history || data.attendance || data.worker?.attendance_history;
    if (!Array.isArray(logs)) return null;
    return [...logs].sort((a, b) => String(b.log_date || '').localeCompare(String(a.log_date || '')));
}

export default function WorkerSearch() {
    const { id: routeId } = useParams();
    const navigate = useNavigate();
    const [query, setQuery] = useState('');
    const [workers, setWorkers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [listError, setListError] = useState('');
    const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
    const [profile, setProfile] = useState(null); // { worker, attendance, documents }
    const [profileLoading, setProfileLoading] = useState(false);
    const [profileError, setProfileError] = useState('');

    useEffect(() => {
        let cancelled = false;
        fetchCertificateThreshold().then(t => { if (!cancelled) setThreshold(t); });
        async function fetchWorkers() {
            try {
                const res = await api.get('/api/admin/workers');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (!cancelled) setWorkers(data.workers || []);
            } catch (err) {
                if (!cancelled) setListError(networkErrorMessage(err));
            }
            if (!cancelled) setLoading(false);
        }
        fetchWorkers();
        return () => { cancelled = true; };
    }, []);

    // Load the full profile whenever the route carries a worker id
    useEffect(() => {
        if (!routeId) {
            setProfile(null);
            setProfileError('');
            return undefined;
        }
        let cancelled = false;
        setProfileLoading(true);
        setProfileError('');
        setProfile(null);
        (async () => {
            try {
                const res = await api.get(`/api/admin/worker/${encodeURIComponent(routeId)}`);
                if (res.status === 404) throw new Error(`Worker ${routeId} not found`);
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || `HTTP ${res.status}`);
                }
                const data = await res.json();
                if (cancelled) return;
                setProfile({
                    worker: data.worker || data,
                    attendance: extractAttendance(data),
                    documents: Array.isArray(data.documents) ? data.documents : null,
                });
            } catch (err) {
                if (!cancelled) setProfileError(networkErrorMessage(err));
            }
            if (!cancelled) setProfileLoading(false);
        })();
        return () => { cancelled = true; };
    }, [routeId]);

    const q = query.toLowerCase();
    const filtered = workers.filter(w =>
        (w.name || '').toLowerCase().includes(q) ||
        (w.worker_id || '').toLowerCase().includes(q) ||
        (w.phone_number || '').includes(query)
    );

    // Prefer the fetched profile; fall back to the list row while it loads
    const listRow = routeId ? workers.find(w => w.worker_id === routeId) : null;
    const selectedWorker = routeId && (profile?.worker || listRow)
        ? normaliseWorker({ ...(listRow || {}), ...(profile?.worker || {}) })
        : null;
    const showPanel = !!routeId;

    if (loading) return <div style={{ padding: '40px', color: 'var(--text-muted)' }}>Loading workers...</div>;

    const days = selectedWorker?.total_days_logged || 0;
    const remaining = Math.max(0, threshold - days);
    const pct = Math.min(100, Math.round((days / threshold) * 100));
    const eligible = days >= threshold;

    return (
        <div>
            <div className="page-header">
                <h2>Worker Search</h2>
                <p>Search by worker ID, name, or phone number</p>
            </div>
            <div className="search-bar">
                <input className="search-input" type="text" placeholder="Search workers by ID, name, or phone..."
                    value={query} onChange={e => setQuery(e.target.value)} />
            </div>

            {listError && (
                <div className="card" role="alert" style={{ marginBottom: '16px', borderLeft: '4px solid var(--danger)', color: 'var(--danger)', fontSize: '14px' }}>
                    Could not load workers: {listError}
                </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: showPanel ? 'repeat(auto-fit, minmax(320px, 1fr))' : '1fr', gap: '20px' }}>
                <div className="card">
                    <h3 style={{ marginBottom: '16px' }}>Workers ({filtered.length})</h3>
                    <div className="table-container">
                        <table>
                            <thead><tr><th>Name</th><th>Language</th><th>Days</th><th>Status</th><th>Docs</th></tr></thead>
                            <tbody>
                                {filtered.map(w => (
                                    <tr key={w.worker_id}
                                        onClick={() => navigate(`/workers/${encodeURIComponent(w.worker_id)}`)}
                                        style={{ cursor: 'pointer', background: w.worker_id === routeId ? 'var(--bg-card-hover)' : undefined }}>
                                        <td><div><strong>{w.name}</strong><div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{w.worker_id}</div></div></td>
                                        <td>{LANGUAGE_MAP[w.preferred_language] || w.preferred_language}</td>
                                        <td>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                <span style={{ fontWeight: 600, color: w.total_days_logged >= threshold ? 'var(--success)' : 'var(--text-primary)' }}>{w.total_days_logged}</span>
                                                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>/ {threshold}</span>
                                            </div>
                                        </td>
                                        <td><span className={`badge ${w.profile_status}`}>{w.profile_status}</span></td>
                                        <td>
                                            <div style={{ display: 'flex', gap: '6px' }}>
                                                <span className={`badge ${w.aadhaar_verified ? 'approved' : 'rejected'}`} style={{ fontSize: '10px', padding: '1px 5px' }}>
                                                    {w.aadhaar_verified ? 'Aadhaar' : 'No ID'}
                                                </span>
                                                <span className={`badge ${w.selfie_verified ? 'approved' : 'rejected'}`} style={{ fontSize: '10px', padding: '1px 5px' }}>
                                                    {w.selfie_verified ? 'Face' : 'No Face'}
                                                </span>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                                {filtered.length === 0 && (
                                    <tr><td colSpan="5" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>No workers found</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {showPanel && (
                    <div className="card">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                            <h3>Worker Profile</h3>
                            <button className="btn btn-outline btn-sm" onClick={() => navigate('/workers')}>Close</button>
                        </div>

                        {profileError && (
                            <p role="alert" style={{ fontSize: '13px', color: 'var(--danger)', marginBottom: '16px' }}>
                                Could not load full profile: {profileError}
                            </p>
                        )}
                        {profileLoading && !selectedWorker && (
                            <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Loading profile...</p>
                        )}

                        {selectedWorker && (
                            <>
                                <div style={{ marginBottom: '20px' }}>
                                    <div style={{ fontSize: '20px', fontWeight: 700 }}>{selectedWorker.name || 'Unnamed worker'}</div>
                                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                                        {selectedWorker.worker_id}{selectedWorker.phone_number ? ` | ${selectedWorker.phone_number}` : ''}
                                    </div>
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
                                    <div>
                                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Status</div>
                                        <span className={`badge ${selectedWorker.profile_status}`}>{selectedWorker.profile_status || '-'}</span>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Language</div>
                                        <span>{LANGUAGE_MAP[selectedWorker.preferred_language] || selectedWorker.preferred_language || '-'}</span>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Days Logged</div>
                                        <span style={{ fontSize: '20px', fontWeight: 700 }}>{days}</span>
                                        <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}> / {threshold}</span>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Days Remaining</div>
                                        <span style={{ fontSize: '20px', fontWeight: 700, color: eligible ? 'var(--success)' : 'var(--warning)' }}>
                                            {remaining}
                                        </span>
                                    </div>
                                </div>
                                <div style={{ marginBottom: '20px' }}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Document Verification</div>
                                    {[
                                        { label: 'Aadhaar Card', verified: selectedWorker.aadhaar_verified },
                                        { label: 'Selfie (Face)', verified: selectedWorker.selfie_verified },
                                    ].map((doc, i) => (
                                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
                                            <span style={{ fontSize: '13px' }}>{doc.label}</span>
                                            <span className={`badge ${doc.verified ? 'approved' : 'rejected'}`}>{doc.verified ? 'Verified' : 'Missing'}</span>
                                        </div>
                                    ))}
                                </div>
                                <div style={{ marginBottom: '20px' }}>
                                    <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Progress to Certificate</div>
                                    <div style={{ background: 'var(--bg-primary)', borderRadius: '8px', height: '12px', overflow: 'hidden' }}>
                                        <div style={{
                                            width: `${pct}%`, height: '100%',
                                            background: eligible ? 'var(--success)' : 'var(--accent-gradient)',
                                            borderRadius: '8px', transition: 'width 0.5s ease',
                                        }} />
                                    </div>
                                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                                        {pct}% complete
                                        {eligible && ' - Certificate Eligible!'}
                                    </div>
                                </div>

                                <div>
                                    <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Attendance History</div>
                                    {profileLoading && <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Loading attendance...</p>}
                                    {!profileLoading && profile?.attendance === null && (
                                        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Attendance history not available.</p>
                                    )}
                                    {!profileLoading && profile?.attendance && profile.attendance.length === 0 && (
                                        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No attendance logged yet.</p>
                                    )}
                                    {!profileLoading && profile?.attendance?.length > 0 && (
                                        <div className="table-container" style={{ maxHeight: '320px', overflowY: 'auto' }}>
                                            <table>
                                                <thead><tr><th>Date</th><th>Site</th><th>Status</th><th>Confidence</th></tr></thead>
                                                <tbody>
                                                    {profile.attendance.map(log => (
                                                        <tr key={log.log_id || log.log_date}>
                                                            <td>{log.log_date}</td>
                                                            <td>{log.site_name || log.site_id || '-'}</td>
                                                            <td><span className={`badge ${log.verification_status === 'pending_review' ? 'pending' : log.verification_status}`}>{(log.verification_status || '-').replace('_', ' ')}</span></td>
                                                            <td>{typeof log.confidence === 'number' ? `${Math.round(log.confidence)}%` : '-'}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
