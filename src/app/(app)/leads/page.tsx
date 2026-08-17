import { leadCounts, listLeads } from "@/lib/leads";
import { formatAuPhone } from "@/lib/phone";
import { formatSydney } from "@/lib/calling-hours";
import { listSuppressed, suppressionCount } from "@/lib/suppression";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  new: "good",
  queued: "warn",
  called: "",
  do_not_call: "bad",
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const leads = listLeads();
  const counts = leadCounts();
  const suppressed = listSuppressed(100);
  const suppressedTotal = suppressionCount();

  return (
    <>
      <h1>Leads</h1>
      <p className="sub">
        Paste a list or upload a spreadsheet. Numbers are checked and de-duplicated on the way in.
      </p>

      {params.imported !== undefined && (
        <div className={Number(params.imported) > 0 ? "notice ok" : "notice warn"}>
          Imported <strong>{params.imported}</strong> lead
          {params.imported === "1" ? "" : "s"}.
          {Number(params.duplicates) > 0 && ` Skipped ${params.duplicates} already on the list.`}
          {Number(params.suppressed) > 0 &&
            ` Blocked ${params.suppressed} on the do-not-contact list.`}
          {Number(params.rejected) > 0 &&
            ` Rejected ${params.rejected} (first problem: ${params.firstError}).`}
        </div>
      )}

      <div className="stats" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="n">{counts.total}</div>
          <div className="l">Total leads</div>
        </div>
        <div className="stat">
          <div className="n">{counts.callable}</div>
          <div className="l">Ready to call</div>
        </div>
        <div className="stat">
          <div className="n">{counts.counts.called ?? 0}</div>
          <div className="l">Already called</div>
        </div>
        <div className="stat">
          <div className="n">{counts.counts.do_not_call ?? 0}</div>
          <div className="l">Do not call</div>
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Paste a list</h2>
          <p className="small muted">
            One business per line: name then phone number, separated by a comma or a tab.
          </p>
          <form action="/api/leads" method="post" encType="multipart/form-data">
            <textarea
              name="paste"
              placeholder={"Novocastrian Electrical, 0412 345 678\nHunter Valley Plumbing, (02) 4956 1234"}
            />
            <button type="submit">Add these leads</button>
          </form>
        </div>

        <div className="panel">
          <h2>Upload a spreadsheet</h2>
          <p className="small muted">
            A CSV with column headings. It looks for <code>business name</code> and <code>phone</code>{" "}
            (plus optional contact, suburb, state, trade, notes). Without headings it assumes the
            first column is the name and the second is the number.
          </p>
          <form action="/api/leads" method="post" encType="multipart/form-data">
            <input type="file" name="file" accept=".csv,text/csv" required />
            <button type="submit">Upload CSV</button>
          </form>
          <details>
            <summary>Feeding this from your lead-finder later</summary>
            <p className="small muted">
              POST JSON to <code>/api/leads</code> with{" "}
              <code>{`{"leads": [{"businessName": "...", "phone": "..."}], "source": "maps-scrape"}`}</code>
              . Same validation and de-duplication as the forms above.
            </p>
          </details>
        </div>
      </div>

      <div className="panel">
        <h2>Do not contact</h2>
        <p className="small muted">
          Permanent. Checked when leads are imported, not just when they&apos;re called — so a
          number here can never be found and added back by a lead run. Nothing on this list is ever
          removed automatically, and marking a lead do-not-call adds its number here too.
        </p>

        {params.dncOk && <div className="notice ok">{params.dncOk}</div>}
        {params.dncError && <div className="notice bad">{params.dncError}</div>}

        <form action="/api/suppression" method="post" className="row" style={{ marginBottom: 14 }}>
          <input type="hidden" name="action" value="add" />
          <div style={{ flex: "1 1 180px" }}>
            <label htmlFor="dncPhone">Phone number</label>
            <input id="dncPhone" name="phone" type="text" placeholder="0412 345 678" required />
          </div>
          <div style={{ flex: "2 1 240px" }}>
            <label htmlFor="dncReason">Reason (optional)</label>
            <input id="dncReason" name="reason" type="text" placeholder="Asked to be removed" />
          </div>
          <button type="submit">Add</button>
        </form>

        {suppressedTotal === 0 ? (
          <p className="muted small">Nobody on the list yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Reason</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {suppressed.map((row) => (
                  <tr key={row.id}>
                    <td>{formatAuPhone(row.phone)}</td>
                    <td className="small">{row.reason}</td>
                    <td className="muted small">{formatSydney(row.added_at)}</td>
                    <td>
                      <form action="/api/suppression" method="post">
                        <input type="hidden" name="action" value="remove" />
                        <input type="hidden" name="phone" value={row.phone} />
                        <button className="secondary" type="submit">
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {suppressedTotal > suppressed.length && (
              <p className="small muted">
                Showing the most recent {suppressed.length} of {suppressedTotal}.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Your list</h2>
        {leads.length === 0 ? (
          <p className="muted">No leads yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Business</th>
                  <th>Phone</th>
                  <th>ICP</th>
                  <th>Status</th>
                  <th>Calls</th>
                  <th>Last called</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id}>
                    <td>
                      {lead.business_name}
                      {lead.suburb && <div className="small muted">{lead.suburb}</div>}
                    </td>
                    <td>{formatAuPhone(lead.phone)}</td>
                    <td>
                      {lead.icp_score === null ? (
                        <span className="muted">—</span>
                      ) : (
                        // The reasons the scorer gave, on hover. They explain
                        // why this lead is worth calling before you ring it.
                        <span
                          className={`badge ${lead.icp_score >= 70 ? "good" : lead.icp_score >= 50 ? "warn" : ""}`}
                          title={
                            lead.icp_reasons
                              ? (JSON.parse(lead.icp_reasons) as string[]).join("\n")
                              : undefined
                          }
                        >
                          {lead.icp_score}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[lead.status] ?? ""}`}>
                        {lead.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td>{lead.call_count}</td>
                    <td className="muted small">
                      {lead.last_called_at ? formatSydney(lead.last_called_at) : "—"}
                    </td>
                    <td>
                      {lead.status !== "do_not_call" ? (
                        <form action={`/api/leads/${lead.id}`} method="post">
                          <input type="hidden" name="status" value="do_not_call" />
                          <button className="secondary" type="submit">
                            Do not call
                          </button>
                        </form>
                      ) : (
                        <form action={`/api/leads/${lead.id}`} method="post">
                          <input type="hidden" name="status" value="new" />
                          <button className="secondary" type="submit">
                            Restore
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
