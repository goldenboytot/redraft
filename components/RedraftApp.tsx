"use client";

import { useEffect } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

// The UI shell. All behaviour lives in lib/redraft/app.js, which wires itself to these ids once mounted.
export default function RedraftApp() {
  useEffect(() => {
    let alive = true;
    import("@/lib/redraft/app.js").then(({ init }) => {
      if (alive) init(supabaseBrowser());
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <div className="app">
        <header className="bar">
          <div className="brand"><span className="brand-mark" aria-hidden="true"></span>Redraft</div>
          <button type="button" className="icon-btn menu-toggle" id="menuBtn" aria-label="Menu" aria-expanded="false" aria-controls="barTools">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
          </button>
          <div className="bar-tools" id="barTools">
            <button type="button" className="session-title" id="sessTitle" title="Rename this session">New session</button>
            <div className="bar-actions">
              <label className="toggle" title="Uses Claude Opus. Slower, better for first builds."><input type="checkbox" id="deep" /> Deep mode</label>
              <button className="btn" id="sessionsBtn" hidden>Sessions</button>
              <button className="btn" id="newBtn">New</button>
            </div>
          </div>
        </header>
        <nav className="view-switch" role="group" aria-label="View">
          <button id="segChat" aria-pressed="true">Chat</button>
          <button id="segDocs" aria-pressed="false">Documents</button>
        </nav>
      
        <main className="panes" id="panes" data-show="chat">
          <section className="pane chat" aria-label="Conversation">
            <div className="log" id="log" aria-live="polite"></div>
            <div className="composer">
              <div className="quick" id="quick"></div>
              <div className="chips" id="pending"></div>
              <div className="input-row">
                <button className="icon-btn" id="attach" title="Attach CV or job description (.docx, .pdf, .txt)" aria-label="Attach files">
                  <svg viewBox="0 0 24 24"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg>
                </button>
                <textarea id="box" rows={1} placeholder="Attach the CV, paste the job description, or ask anything" />
                <button className="btn primary send-btn" id="send" aria-label="Send" style={{ height: 42 }}>
                  <span className="send-label">Send</span>
                  <svg className="send-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l18-8-8 18-2-8-8-2z"/></svg>
                </button>
              </div>
              <input type="file" id="file" multiple accept=".pdf,.docx,.txt,.md" hidden />
              <div className="hint" id="hint">Loading…</div>
            </div>
          </section>
      
          <section className="pane docs" aria-label="Documents">
            <nav className="tabs" role="tablist" id="tabs">
              <button role="tab" data-tab="resume" aria-selected="true">Resume</button>
              <button role="tab" data-tab="cover" aria-selected="false">Cover letter</button>
              <button role="tab" data-tab="keywords" aria-selected="false">Keywords<span className="count" id="kwCount"></span></button>
              <button role="tab" data-tab="files" aria-selected="false">Files<span className="count" id="fileCount"></span></button>
            </nav>
            <div className="docbody" id="docbody"></div>
          </section>
        </main>
      </div>
      <div className="drawer" id="drawer" hidden><div className="drawer-panel" id="drawerPanel"></div></div>
      <div className="modal" id="nameModal" hidden>
        <div className="modal-panel">
          <h2>Name this session</h2>
          <p className="note">It's saved so you can come back to it from Sessions.</p>
          <input type="text" id="nameInput" aria-label="Session name" />
          <div className="row-actions" style={{ justifyContent: "flex-end" }}>
            <button className="btn" id="nameCancel">Cancel</button>
            <button className="btn primary" id="nameSave">Save &amp; start new</button>
          </div>
        </div>
      </div>
      <div className="toast" id="toast" hidden></div>
    </>
  );
}
