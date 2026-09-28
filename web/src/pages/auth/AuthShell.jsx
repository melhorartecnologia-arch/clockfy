import React from 'react';

export default function AuthShell({ title, children, footer }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="logo"><img src="/favicon.svg" alt="" style={{ width: 32, verticalAlign: 'middle', marginRight: 8 }} />Clockfy</div>
        {title && <h2 className="center">{title}</h2>}
        {children}
        {footer && <div className="center mt small muted">{footer}</div>}
      </div>
    </div>
  );
}
