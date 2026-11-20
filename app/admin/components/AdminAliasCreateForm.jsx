"use client";

export default function AdminAliasCreateForm({
  activeDomains,
  aliasFormAddress,
  loading,
  onGenerateAlias,
  onReset,
  onSave,
  setAliasFormAddress
}) {
  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h5 className="mb-0"><i className="bi bi-plus-circle me-2" />Buat Alias Baru</h5>
      </div>
      <div className="p-4">
        <div className="alert alert-info d-flex align-items-start gap-2 mb-4" role="note">
          <i className="bi bi-key-fill mt-1" />
          <div>
            <strong>Token akses dibuat otomatis.</strong>
            <div className="small mt-1">Server akan menampilkan token satu kali setelah alias dibuat. Simpan token sebelum menutup halaman.</div>
          </div>
        </div>

        <section className="mb-4">
          <label className="form-label fw-bold mb-2" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--bs-secondary-color)' }}>1. Pilih Alamat Email</label>
          <div className="admin-alias-address" style={{ display: 'flex', alignItems: 'stretch', border: '1.5px solid var(--bs-border-color)', borderRadius: '12px', overflow: 'hidden', background: 'var(--bs-tertiary-bg)', marginBottom: '0.75rem' }}>
            <input
              value={aliasFormAddress.split('@')[0] || ''}
              onChange={(e) => {
                const domain = aliasFormAddress.includes('@') ? aliasFormAddress.split('@')[1] : (activeDomains[0]?.name || '');
                setAliasFormAddress(e.target.value.replace(/\s+/g, '').toLowerCase() + (domain ? '@' + domain : ''));
              }}
              style={{ flex: 1, border: 'none', background: 'transparent', padding: '0.875rem 1rem', fontSize: '1rem', fontWeight: 500, outline: 'none', minWidth: 0 }}
              placeholder="nama-anda"
              spellCheck="false"
            />
            <span style={{ padding: '0 0.5rem', display: 'flex', alignItems: 'center', fontSize: '1rem', color: 'var(--bs-secondary-color)', fontWeight: 600 }}>@</span>
            <select
              value={aliasFormAddress.includes('@') ? aliasFormAddress.split('@')[1] : ''}
              onChange={(e) => setAliasFormAddress((aliasFormAddress.split('@')[0] || '') + '@' + e.target.value)}
              style={{ border: 'none', background: 'transparent', padding: '0.875rem 0.75rem', fontSize: '0.95rem', fontWeight: 500, outline: 'none', cursor: 'pointer', maxWidth: 200, minWidth: 120, appearance: 'none', WebkitAppearance: 'none' }}
            >
              {activeDomains.length === 0 && <option value="">-</option>}
              {activeDomains.map((domain) => <option key={domain.name} value={domain.name}>{domain.name}</option>)}
            </select>
          </div>
          {aliasFormAddress.includes('@') && <div className="rounded-3 px-3 py-2" style={{ background: 'rgba(var(--bs-primary-rgb), 0.06)', border: '1px solid rgba(var(--bs-primary-rgb), 0.15)', fontFamily: 'monospace', fontSize: '0.9rem' }}><i className="bi bi-envelope-fill text-primary me-2" />{aliasFormAddress}</div>}
        </section>

        <div className="d-flex gap-2 mt-4" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-primary" style={{ borderRadius: '10px', padding: '0.6rem 1.25rem', fontWeight: 600, fontSize: '0.9rem' }} onClick={onSave} disabled={loading || !aliasFormAddress.includes('@')}><i className="bi bi-floppy me-2" />Simpan Alias</button>
          <button className="btn btn-outline-primary" style={{ borderRadius: '10px', padding: '0.6rem 1rem', fontWeight: 600, fontSize: '0.9rem' }} type="button" onClick={onGenerateAlias}><i className="bi bi-shuffle me-1" />Acak</button>
          <button className="btn btn-outline-secondary" style={{ borderRadius: '10px', padding: '0.6rem 1rem', fontWeight: 600, fontSize: '0.9rem' }} onClick={onReset}><i className="bi bi-eraser me-1" />Reset</button>
        </div>
      </div>
    </div>
  );
}
