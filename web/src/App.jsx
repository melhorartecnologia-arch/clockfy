import React, { Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useStore } from './store.jsx';
import Layout from './components/Layout.jsx';
import { Spinner } from './components/ui.jsx';
import * as P from './pages/index.js';

function Protected({ children }) {
  const { user, loading } = useStore();
  const loc = useLocation();
  if (loading) return <Spinner block />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return children;
}

export default function App() {
  return (
    <Suspense fallback={<Spinner block />}>
      <Routes>
        <Route path="/login" element={<P.Login />} />
        <Route path="/register" element={<P.Register />} />
        <Route path="/forgot-password" element={<P.ForgotPassword />} />
        <Route path="/reset-password" element={<P.ResetPassword />} />
        <Route path="/invite" element={<P.Invite />} />
        <Route path="/shared/:id" element={<P.SharedReport />} />
        <Route path="/kiosk/:code" element={<P.KioskPublic />} />
        <Route element={<Protected><Layout /></Protected>}>
          <Route index element={<Navigate to="/tracker" replace />} />
          <Route path="/tracker" element={<P.Tracker />} />
          <Route path="/timesheet" element={<P.Timesheet />} />
          <Route path="/calendar" element={<P.Calendar />} />
          <Route path="/dashboard" element={<P.Dashboard />} />
          <Route path="/reports/*" element={<P.Reports />} />
          <Route path="/projects" element={<P.Projects />} />
          <Route path="/projects/:id/*" element={<P.ProjectDetail />} />
          <Route path="/team/*" element={<P.Team />} />
          <Route path="/clients" element={<P.Clients />} />
          <Route path="/tags" element={<P.Tags />} />
          <Route path="/schedule/*" element={<P.Schedule />} />
          <Route path="/approvals/*" element={<P.Approvals />} />
          <Route path="/time-off/*" element={<P.TimeOff />} />
          <Route path="/expenses/*" element={<P.Expenses />} />
          <Route path="/invoices" element={<P.Invoices />} />
          <Route path="/invoices/:id" element={<P.InvoiceDetail />} />
          <Route path="/settings/*" element={<P.Settings />} />
          <Route path="/profile" element={<P.Profile />} />
          <Route path="/kiosks" element={<P.Kiosks />} />
          <Route path="/webhooks" element={<P.Webhooks />} />
          <Route path="/alerts" element={<P.Alerts />} />
          <Route path="/audit-log" element={<P.AuditLog />} />
          <Route path="/import" element={<P.Import />} />
          <Route path="/accounts" element={<P.Accounts />} />
          <Route path="/notifications" element={<P.Notifications />} />
          <Route path="*" element={<Navigate to="/tracker" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
