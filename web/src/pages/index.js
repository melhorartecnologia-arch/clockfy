// Page registry. Each page is a default-exported React component.
import { lazy } from 'react';

export const Login = lazy(() => import('./auth/Login.jsx'));
export const Register = lazy(() => import('./auth/Register.jsx'));
export const ForgotPassword = lazy(() => import('./auth/ForgotPassword.jsx'));
export const ResetPassword = lazy(() => import('./auth/ResetPassword.jsx'));
export const Invite = lazy(() => import('./auth/Invite.jsx'));

export const Tracker = lazy(() => import('./Tracker.jsx'));
export const Timesheet = lazy(() => import('./Timesheet.jsx'));
export const Calendar = lazy(() => import('./Calendar.jsx'));
export const Dashboard = lazy(() => import('./Dashboard.jsx'));
export const Reports = lazy(() => import('./Reports.jsx'));
export const SharedReport = lazy(() => import('./SharedReport.jsx'));
export const Projects = lazy(() => import('./Projects.jsx'));
export const ProjectDetail = lazy(() => import('./ProjectDetail.jsx'));
export const Team = lazy(() => import('./Team.jsx'));
export const Clients = lazy(() => import('./Clients.jsx'));
export const Tags = lazy(() => import('./Tags.jsx'));
export const Schedule = lazy(() => import('./Schedule.jsx'));
export const Approvals = lazy(() => import('./Approvals.jsx'));
export const TimeOff = lazy(() => import('./TimeOff.jsx'));
export const Expenses = lazy(() => import('./Expenses.jsx'));
export const Invoices = lazy(() => import('./Invoices.jsx'));
export const InvoiceDetail = lazy(() => import('./InvoiceDetail.jsx'));
export const Settings = lazy(() => import('./Settings.jsx'));
export const Profile = lazy(() => import('./Profile.jsx'));
export const Kiosks = lazy(() => import('./Kiosks.jsx'));
export const KioskPublic = lazy(() => import('./KioskPublic.jsx'));
export const Webhooks = lazy(() => import('./Webhooks.jsx'));
export const Alerts = lazy(() => import('./Alerts.jsx'));
export const AuditLog = lazy(() => import('./AuditLog.jsx'));
export const Import = lazy(() => import('./Import.jsx'));
export const Notifications = lazy(() => import('./Notifications.jsx'));
