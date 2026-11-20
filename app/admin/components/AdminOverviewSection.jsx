export default function AdminOverviewSection({
  activeDomains,
  aliasRows,
  loading,
  logCount,
  stats
}) {
  const protectedAliases = aliasRows.filter((row) => Boolean(row.hasAccessToken)).length;

  return (
    <div className="admin-overview">
      {loading && !stats ? (
        <div className="admin-kpi-grid">
          {[0, 1, 2, 3].map((idx) => (
            <div key={idx} className="admin-kpi-card admin-skeleton-card">
              <div className="admin-skeleton" style={{ width: 36, height: 36, borderRadius: 12 }} />
              <div className="admin-skeleton admin-skeleton-line" style={{ width: '60%' }} />
              <div className="admin-skeleton" style={{ width: '40%', height: 22, marginTop: 12 }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="admin-kpi-grid">
          <article className="admin-kpi-card">
            <div className="admin-kpi-icon bg-primary-subtle text-primary"><i className="bi bi-at" /></div>
            <p className="admin-kpi-label">Total Alias</p>
            <h3 className="admin-kpi-value">{stats?.totalAliases ?? aliasRows.length}</h3>
          </article>
          <article className="admin-kpi-card">
            <div className="admin-kpi-icon bg-warning-subtle text-warning"><i className="bi bi-globe2" /></div>
            <p className="admin-kpi-label">Domain Aktif</p>
            <h3 className="admin-kpi-value">{activeDomains.length}</h3>
          </article>
          <article className="admin-kpi-card">
            <div className="admin-kpi-icon bg-success-subtle text-success"><i className="bi bi-envelope-check" /></div>
            <p className="admin-kpi-label">Email Tercatat</p>
            <h3 className="admin-kpi-value">{logCount}</h3>
          </article>
          <article className="admin-kpi-card">
            <div className="admin-kpi-icon bg-info-subtle text-info"><i className="bi bi-shield-lock" /></div>
            <p className="admin-kpi-label">Alias Dengan Token</p>
            <h3 className="admin-kpi-value">{protectedAliases}</h3>
          </article>
        </div>
      )}
    </div>
  );
}
