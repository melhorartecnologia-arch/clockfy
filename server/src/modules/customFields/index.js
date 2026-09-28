import { Router } from 'express';
import { one, rows, query, insert } from '../../lib/db.js';
import { newId } from '../../lib/ids.js';
import { parse, z } from '../../lib/validate.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { customFieldDto } from '../../lib/dto.js';

export const router = Router({ mergeParams: true });          // /workspaces/:workspaceId/custom-fields
export const projectRouter = Router({ mergeParams: true });   // /workspaces/:workspaceId/projects/:projectId/custom-fields

const TYPES = ['TXT', 'NUMBER', 'DROPDOWN_SINGLE', 'DROPDOWN_MULTIPLE', 'CHECKBOX', 'LINK'];
const STATUS = ['VISIBLE', 'INVISIBLE', 'INACTIVE'];

const cfSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(TYPES),
  entityType: z.enum(['TIMEENTRY', 'USER']).optional(),
  placeholder: z.string().max(200).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  allowedValues: z.array(z.string()).optional(),
  workspaceDefaultValue: z.any().optional(),
  status: z.enum(STATUS).optional(),
  required: z.boolean().optional(),
  onlyAdminCanEdit: z.boolean().optional(),
});

export async function fieldDto(cf) {
  const defaults = await rows('SELECT * FROM custom_field_project_defaults WHERE custom_field_id = $1', [cf.id]);
  return customFieldDto(cf, defaults);
}

export async function getField(workspaceId, id) {
  const cf = await one('SELECT * FROM custom_fields WHERE id = $1 AND workspace_id = $2', [id, workspaceId]);
  if (!cf) throw notFound('Custom field not found', 404);
  return cf;
}

// Validates/normalizes a value according to the field type
export function normalizeValue(cf, value) {
  if (value == null || value === '') return null;
  switch (cf.type) {
    case 'NUMBER': { const n = Number(value); if (Number.isNaN(n)) throw badRequest(`Custom field "${cf.name}" expects a number`, 400); return n; }
    case 'CHECKBOX': return value === true || value === 'true';
    case 'DROPDOWN_SINGLE': {
      const v = String(value);
      if ((cf.allowed_values || []).length && !cf.allowed_values.includes(v)) throw badRequest(`Value "${v}" is not allowed for custom field "${cf.name}"`, 400);
      return v;
    }
    case 'DROPDOWN_MULTIPLE': {
      const arr = Array.isArray(value) ? value.map(String) : String(value).split(',').map((s) => s.trim()).filter(Boolean);
      for (const v of arr) if ((cf.allowed_values || []).length && !cf.allowed_values.includes(v)) throw badRequest(`Value "${v}" is not allowed for custom field "${cf.name}"`, 400);
      return arr;
    }
    default: return String(value);
  }
}

router.get('/', async (req, res) => {
  const conds = ['workspace_id = $1']; const params = [req.workspace.id];
  if (req.query.name) { params.push(`%${String(req.query.name).toLowerCase()}%`); conds.push(`lower(name) LIKE $${params.length}`); }
  if (req.query.status) { params.push(String(req.query.status).toUpperCase()); conds.push(`status = $${params.length}`); }
  if (req.query['entity-type']) { params.push(String(req.query['entity-type']).toUpperCase()); conds.push(`entity_type = $${params.length}`); }
  const list = await rows(`SELECT * FROM custom_fields WHERE ${conds.join(' AND ')} ORDER BY created_at`, params);
  res.json(await Promise.all(list.map(fieldDto)));
});

router.get('/:customFieldId', async (req, res) => res.json(await fieldDto(await getField(req.workspace.id, req.params.customFieldId))));

router.post('/', async (req, res) => {
  req.ctx.requireAdmin();
  const b = parse(cfSchema, req.body);
  const cf = await insert('custom_fields', {
    id: req.body.id && /^[a-f0-9]{24}$/.test(req.body.id) ? req.body.id : newId(), workspace_id: req.workspace.id, name: b.name, type: b.type, entity_type: b.entityType || 'TIMEENTRY',
    placeholder: b.placeholder || null, description: b.description || null, allowed_values: b.allowedValues || [],
    workspace_default_value: b.workspaceDefaultValue === undefined ? null : JSON.stringify(b.workspaceDefaultValue), status: b.status || 'VISIBLE', required: !!b.required, only_admin_can_edit: !!b.onlyAdminCanEdit,
  });
  res.status(201).json(await fieldDto(cf));
});

router.put('/:customFieldId', async (req, res) => {
  req.ctx.requireAdmin();
  const cf = await getField(req.workspace.id, req.params.customFieldId);
  const b = parse(cfSchema.partial(), req.body);
  const updated = await one(
    `UPDATE custom_fields SET name = COALESCE($2, name), type = COALESCE($3, type), placeholder = COALESCE($4, placeholder), description = COALESCE($5, description), allowed_values = COALESCE($6, allowed_values), workspace_default_value = CASE WHEN $7::text IS NULL THEN workspace_default_value ELSE $7::jsonb END, status = COALESCE($8, status), required = COALESCE($9, required), only_admin_can_edit = COALESCE($10, only_admin_can_edit) WHERE id = $1 RETURNING *`,
    [cf.id, b.name ?? null, b.type ?? null, b.placeholder ?? null, b.description ?? null, b.allowedValues ? JSON.stringify(b.allowedValues) : null, b.workspaceDefaultValue === undefined ? null : JSON.stringify(b.workspaceDefaultValue), b.status ?? null, b.required ?? null, b.onlyAdminCanEdit ?? null],
  );
  res.json(await fieldDto(updated));
});

router.delete('/:customFieldId', async (req, res) => {
  req.ctx.requireAdmin();
  const cf = await getField(req.workspace.id, req.params.customFieldId);
  await query('DELETE FROM custom_fields WHERE id = $1', [cf.id]);
  res.status(204).end();
});

// Project-level defaults --------------------------------------------------------
projectRouter.get('/', async (req, res) => {
  const conds = ['f.workspace_id = $1']; const params = [req.workspace.id, req.params.projectId];
  if (req.query.status) { params.push(String(req.query.status).toUpperCase()); conds.push(`COALESCE(d.status, f.status) = $${params.length}`); }
  if (req.query['entity-type']) { params.push(String(req.query['entity-type']).toUpperCase()); conds.push(`f.entity_type = $${params.length}`); }
  const list = await rows(`SELECT f.*, d.value AS project_value, d.status AS project_status FROM custom_fields f LEFT JOIN custom_field_project_defaults d ON d.custom_field_id = f.id AND d.project_id = $2 WHERE ${conds.join(' AND ')} ORDER BY f.created_at`, params);
  res.json(await Promise.all(list.map(fieldDto)));
});

projectRouter.patch('/:customFieldId', async (req, res) => {
  req.ctx.requireProjectManager(req.params.projectId);
  const cf = await getField(req.workspace.id, req.params.customFieldId);
  const { defaultValue, status } = parse(z.object({ defaultValue: z.any().optional(), status: z.enum(STATUS).optional() }), req.body);
  await query(`INSERT INTO custom_field_project_defaults (custom_field_id, project_id, value, status) VALUES ($1,$2,$3,$4) ON CONFLICT (custom_field_id, project_id) DO UPDATE SET value = COALESCE(EXCLUDED.value, custom_field_project_defaults.value), status = COALESCE($4, custom_field_project_defaults.status)`,
    [cf.id, req.params.projectId, defaultValue === undefined ? null : JSON.stringify(defaultValue), status || null]);
  res.json(await fieldDto(cf));
});

projectRouter.delete('/:customFieldId', async (req, res) => {
  req.ctx.requireProjectManager(req.params.projectId);
  const cf = await getField(req.workspace.id, req.params.customFieldId);
  await query('DELETE FROM custom_field_project_defaults WHERE custom_field_id = $1 AND project_id = $2', [cf.id, req.params.projectId]);
  res.json(await fieldDto(cf));
});

export default router;
