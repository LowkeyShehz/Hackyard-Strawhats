import React, { useState } from 'react';
import { downloadFile } from '../utils/download';

// Adaption Visualize is a hosted app (no embed or API): officers download a dataset here and
// upload it there to ask questions and get charts. The exports are pseudonymised server-side.
const VISUALIZE_URL = 'https://www.adaptionlabs.ai/app/auth';

const DATASETS = [
    { file: 'attendance.csv', label: 'Check-ins', hint: 'One row per check-in: site, hour, status, confidence scores, fraud patterns' },
    { file: 'fraud.csv', label: 'Fraud signals', hint: 'One row per signal: phone farm, static GPS, impossible travel, shared face, re-sent or screen selfie' },
];

export default function AdaptionExport() {
    const [days, setDays] = useState(30);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');

    const download = async (file) => {
        setBusy(file);
        setError('');
        try {
            await downloadFile(`/api/admin/export/${file}?days=${days}`, `nirman-mitra-${file}`);
        } catch (err) {
            setError(`Export failed: ${err.message}`);
        } finally {
            setBusy('');
        }
    };

    return (
        <div className="card" style={{ marginTop: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
                <div style={{ maxWidth: '560px' }}>
                    <h3 style={{ marginBottom: '6px' }}>Explore in Adaption Visualize</h3>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                        Download a dataset, then upload it to Adaption Visualize and ask questions in plain language,
                        such as "which sites have the most phone-farm flags after 6 pm?". Workers appear as codes;
                        names, phone numbers, Aadhaar details and GPS positions are never exported.
                    </p>
                </div>
                <label style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    Period
                    <select className="search-input" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }}>
                        <option value={7}>Last 7 days</option>
                        <option value={30}>Last 30 days</option>
                        <option value={90}>Last 90 days</option>
                    </select>
                </label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px', marginTop: '16px' }}>
                {DATASETS.map((d) => (
                    <div key={d.file} style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius-sm)', padding: '12px' }}>
                        <p style={{ fontWeight: 600, marginBottom: '4px' }}>{d.label}</p>
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>{d.hint}</p>
                        <button className="btn btn-outline btn-sm" onClick={() => download(d.file)} disabled={Boolean(busy)}>
                            {busy === d.file ? 'Preparing...' : `Download ${d.file}`}
                        </button>
                    </div>
                ))}
            </div>

            <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <a className="btn btn-primary btn-sm" href={VISUALIZE_URL} target="_blank" rel="noopener noreferrer">
                    Open Adaption Visualize
                </a>
                {error && <span role="alert" style={{ fontSize: '13px', color: 'var(--danger)' }}>{error}</span>}
            </div>
        </div>
    );
}
