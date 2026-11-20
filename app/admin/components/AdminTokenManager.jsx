"use client";

import { useEffect, useState } from 'react';
import { formatDateTime, localizeErrorMessage } from '../admin-utils';

const STATUS_META = {
  available: { label: 'Tersedia', className: 'bg-success-subtle text-success' },
  waiting: { label: 'Menunggu', className: 'bg-warning-subtle text-warning' },
  fulfilled: { label: 'Terpenuhi', className: 'bg-primary-subtle text-primary' },
  revoked: { label: 'Dicabut', className: 'bg-secondary-subtle text-secondary' }
};

export default function AdminTokenManager({ address, onClose, onCreate, onLoad, onRevoke, onToast }) {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    onLoad(address)
      .then((data) => { if (active) setTokens(data.tokens || []); })
      .catch((err) => { if (active) setError(localizeErrorMessage(err?.message)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [address, onLoad]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  async function createToken() {
    setCreating(true);
    setError('');
    try {
      const data = await onCreate(address);
      const newToken = { ...(data.token || {}), accessToken: data.accessToken };
      setTokens((current) => [...current, newToken]);
      onToast('Token baru berhasil dibuat');
    } catch (err) {
      setError(localizeErrorMessage(err?.message));
    } finally {
      setCreating(false);
    }
  }

  async function revokeToken(token) {
    if (!window.confirm('Cabut token ini? Token tidak dapat dipakai untuk membuka sesi baru.')) return;
    setRevokingId(token.id);
    setError('');
    try {
      const data = await onRevoke(address, token.id);
      setTokens((current) => current.map((item) => (
        item.id === token.id ? { ...item, ...(data.token || {}), status: 'revoked' } : item
      )));
      onToast('Token berhasil dicabut');
    } catch (err) {
      setError(localizeErrorMessage(err?.message));
    } finally {
      setRevokingId('');
    }
  }

  async function copyToken(accessToken) {
    try {
      await navigator.clipboard.writeText(accessToken);
      onToast('Token akses disalin');
    } catch {
      setError('Browser tidak dapat menyalin token. Pilih token lalu salin secara manual.');
    }
  }

  return (
    <div className="admin-token-modal" role="dialog" aria-modal="true" aria-labelledby="token-manager-title" onMouseDown={onClose}>
      <section className="admin-token-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header className="admin-token-header">
          <div className="min-width-0">
            <h3 id="token-manager-title">Kelola token</h3>
            <p>{address}</p>
          </div>
          <button type="button" className="btn btn-sm btn-outline-secondary btn-icon" onClick={onClose} aria-label="Tutup panel token">
            <i className="bi bi-x-lg" />
          </button>
        </header>

        <div className="admin-token-toolbar">
          <p>Setiap token hanya dapat ditukar sekali dan menunggu tepat satu email.</p>
          <button type="button" className="btn btn-primary" onClick={createToken} disabled={creating || loading}>
            {creating ? <span className="spinner-border spinner-border-sm me-2" /> : <i className="bi bi-plus-lg me-2" />}
            Buat token
          </button>
        </div>

        {error && <div className="alert alert-danger mx-3 mt-3 mb-0" role="alert">{error}</div>}

        <div className="admin-token-list">
          {loading && (
            <div className="admin-token-state"><span className="spinner-border spinner-border-sm me-2" />Memuat token...</div>
          )}
          {!loading && tokens.length === 0 && <div className="admin-token-state">Belum ada token untuk alias ini.</div>}
          {!loading && tokens.map((token) => {
            const status = STATUS_META[token.status] || { label: token.status || '-', className: 'bg-secondary-subtle text-secondary' };
            const canRevoke = token.status === 'available' || token.status === 'waiting';
            return (
              <article className="admin-token-item" key={token.id}>
                <div className="admin-token-item-heading">
                  <span className={`badge ${status.className}`}>{status.label}</span>
                  <span className="admin-token-id">ID {token.id}</span>
                </div>
                <div className="admin-token-copy-row">
                  <input className="form-control" value={token.accessToken || ''} readOnly aria-label={`Token akses ${token.id}`} />
                  <button type="button" className="btn btn-outline-primary" onClick={() => copyToken(token.accessToken)} disabled={!token.accessToken}>
                    <i className="bi bi-copy me-1" />Salin
                  </button>
                </div>
                <dl className="admin-token-meta">
                  <div><dt>Dibuat</dt><dd>{formatDateTime(token.createdAt)}</dd></div>
                  <div><dt>Dipakai</dt><dd>{formatDateTime(token.consumedAt)}</dd></div>
                  <div><dt>Terpenuhi</dt><dd>{formatDateTime(token.fulfilledAt)}</dd></div>
                  <div><dt>Pesan</dt><dd className="text-break">{token.messageId || '-'}</dd></div>
                </dl>
                <div className="admin-token-item-footer">
                  {canRevoke ? (
                    <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => revokeToken(token)} disabled={revokingId === token.id}>
                      {revokingId === token.id ? <span className="spinner-border spinner-border-sm me-1" /> : <i className="bi bi-slash-circle me-1" />}
                      Cabut token
                    </button>
                  ) : (
                    <small className="text-muted">{token.status === 'fulfilled' ? 'Token terpenuhi tidak dapat dicabut.' : 'Token sudah dicabut.'}</small>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
