import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, FileText, GraduationCap, Loader2, Pencil, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import axios from 'axios';
import { toast } from 'sonner';
import { API } from '@/config/api';
import { getAuthHeader, useAuth } from '@/contexts/AuthContext';
import { getUploadUrl } from '@/utils/imageUtils';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const EMPTY_FORM = {
  course_id: '',
  start_date: '',
  expiration_date: '',
  certificate_number: '',
  training_provider: '',
  notes: ''
};

const toDateInput = (value) => {
  if (!value) return '';
  const normalized = String(value);
  return normalized.length >= 10 ? normalized.slice(0, 10) : normalized;
};

const toApiDate = (value) => (value ? `${value}T00:00:00+00:00` : '');
const formatDate = (value) => (value ? new Date(value).toLocaleDateString('pt-BR') : '-');

const statusStyles = {
  valid: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  expiring: 'bg-amber-100 text-amber-700 border-amber-200',
  expired: 'bg-red-100 text-red-700 border-red-200',
  inactive: 'bg-slate-200 text-slate-700 border-slate-300',
  unknown: 'bg-slate-200 text-slate-700 border-slate-300'
};

function buildFormData(formData, file, mode) {
  const body = new FormData();
  if (mode === 'create') body.append('course_id', formData.course_id);
  if (formData.start_date) body.append('start_date', toApiDate(formData.start_date));
  if (formData.expiration_date) body.append('expiration_date', toApiDate(formData.expiration_date));
  if (formData.certificate_number) body.append('certificate_number', formData.certificate_number.trim());
  if (formData.training_provider) body.append('training_provider', formData.training_provider.trim());
  if (formData.notes) body.append('notes', formData.notes.trim());
  if (file) body.append('certificate_file', file);
  return body;
}

function groupRecords(records) {
  const grouped = new Map();
  records.forEach((record) => {
    const key = record.course_id || record.id;
    if (!grouped.has(key)) {
      grouped.set(key, {
        course_id: record.course_id,
        course_name: record.course_name,
        course_active: record.course_active,
        current: null,
        history: []
      });
    }
    const entry = grouped.get(key);
    if (record.is_current && !entry.current) {
      entry.current = record;
    } else {
      entry.history.push(record);
    }
  });
  return Array.from(grouped.values()).sort((left, right) => (left.course_name || '').localeCompare(right.course_name || ''));
}

export default function EmployeeCoursesSection({ employeeId, collaborator }) {
  const { user } = useAuth();
  const [records, setRecords] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState('create');
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [selectedFile, setSelectedFile] = useState(null);

  const canManage = ['admin', 'seguranca_trabalho', 'almoxarifado'].includes(user?.role);
  const canDeactivate = ['admin', 'seguranca_trabalho'].includes(user?.role);
  const employeeIsInactive = collaborator?.status === 'inactive';
  const allowInactiveEmployeeWrite = user?.role === 'admin';

  const groupedRecords = useMemo(() => groupRecords(records), [records]);
  const activeCatalog = useMemo(() => catalog.filter((course) => course.active !== false), [catalog]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const requests = [axios.get(`${API}/employees/${employeeId}/courses`, { headers: getAuthHeader() })];
      if (canManage) {
        requests.push(axios.get(`${API}/courses`, { headers: getAuthHeader() }));
      }
      const [recordsRes, catalogRes] = await Promise.all(requests);
      setRecords(recordsRes.data || []);
      setCatalog(catalogRes?.data || []);
    } catch (error) {
      console.error('Erro ao carregar cursos do colaborador:', error);
      toast.error(error.response?.data?.detail || 'Erro ao carregar cursos e certificados');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (employeeId) fetchData();
  }, [employeeId, canManage]);

  const openCreateDialog = () => {
    setDialogMode('create');
    setSelectedRecord(null);
    setSelectedFile(null);
    setFormData(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEditDialog = (record, mode = 'edit') => {
    setDialogMode(mode);
    setSelectedRecord(record);
    setSelectedFile(null);
    setFormData({
      course_id: record.course_id || '',
      start_date: toDateInput(record.start_date),
      expiration_date: toDateInput(record.expiration_date),
      certificate_number: record.certificate_number || '',
      training_provider: record.training_provider || '',
      notes: record.notes || ''
    });
    setDialogOpen(true);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (employeeIsInactive && !allowInactiveEmployeeWrite) {
      toast.error('Colaborador inativo nao pode receber novos lancamentos ou renovacoes');
      return;
    }
    try {
      setSaving(true);
      const body = buildFormData(formData, selectedFile, dialogMode === 'create' ? 'create' : 'update');
      if (dialogMode === 'create') {
        await axios.post(`${API}/employees/${employeeId}/courses`, body, { headers: { ...getAuthHeader(), 'Content-Type': 'multipart/form-data' } });
        toast.success('Certificado cadastrado com sucesso');
      } else if (dialogMode === 'edit') {
        await axios.patch(`${API}/employees/${employeeId}/courses/${selectedRecord.id}`, body, { headers: { ...getAuthHeader(), 'Content-Type': 'multipart/form-data' } });
        toast.success('Certificado atualizado com sucesso');
      } else {
        await axios.post(`${API}/employees/${employeeId}/courses/${selectedRecord.id}/renew`, body, { headers: { ...getAuthHeader(), 'Content-Type': 'multipart/form-data' } });
        toast.success('Certificado renovado com sucesso');
      }
      setDialogOpen(false);
      setFormData(EMPTY_FORM);
      setSelectedRecord(null);
      setSelectedFile(null);
      fetchData();
    } catch (error) {
      console.error('Erro ao salvar certificado:', error);
      toast.error(error.response?.data?.detail || 'Erro ao salvar certificado');
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async (record) => {
    const reason = window.prompt('Informe o motivo da inativacao/cancelamento deste certificado:');
    if (reason === null) return;
    if (!reason.trim()) {
      toast.error('Motivo obrigatorio');
      return;
    }
    try {
      await axios.post(`${API}/employees/${employeeId}/courses/${record.id}/deactivate`, { reason: reason.trim() }, { headers: getAuthHeader() });
      toast.success('Certificado inativado com sucesso');
      fetchData();
    } catch (error) {
      console.error('Erro ao inativar certificado:', error);
      toast.error(error.response?.data?.detail || 'Erro ao inativar certificado');
    }
  };

  const renderBadge = (record) => {
    const badgeClass = statusStyles[record.status] || statusStyles.unknown;
    return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${badgeClass}`}>{record.status_label}</span>;
  };

  const renderRecord = (record, isHistory = false) => (
    <div key={record.id} className={`rounded-lg border p-4 ${isHistory ? 'border-slate-200 bg-slate-50' : 'border-slate-200 bg-white'}`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {renderBadge(record)}
            {!record.active && <span className="inline-flex rounded-full border border-slate-300 bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">Cancelado</span>}
            {record.is_current && record.active && <span className="inline-flex rounded-full border border-blue-200 bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-700">Vigente</span>}
            {record.course_active === false && <span className="inline-flex rounded-full border border-amber-200 bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">Curso do catalogo inativo</span>}
          </div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3 text-sm text-slate-700">
            <p><span className="font-medium text-slate-900">Inicio:</span> {formatDate(record.start_date)}</p>
            <p><span className="font-medium text-slate-900">Validade:</span> {formatDate(record.expiration_date)}</p>
            <p><span className="font-medium text-slate-900">Dias alerta:</span> {record.alert_days_before_expiration ?? 0}</p>
            <p><span className="font-medium text-slate-900">Certificado:</span> {record.certificate_number || '-'}</p>
            <p><span className="font-medium text-slate-900">Instituicao:</span> {record.training_provider || '-'}</p>
            <p><span className="font-medium text-slate-900">Lancado por:</span> {record.created_by || '-'}</p>
          </div>
          {record.notes && <p className="text-sm text-slate-600"><span className="font-medium text-slate-900">Observacoes:</span> {record.notes}</p>}
          {record.certificate_file_path && (
            <a href={getUploadUrl(record.certificate_file_path)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-medium text-blue-700 hover:text-blue-800">
              <FileText className="h-4 w-4" />
              {record.certificate_file_name || 'Abrir certificado'}
            </a>
          )}
          {!record.active && (
            <p className="text-xs text-slate-500">Inativado por {record.deactivated_by || '-'} em {formatDate(record.deactivated_at)}. Motivo: {record.deactivation_reason || '-'}</p>
          )}
        </div>
        {!isHistory && canManage && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => openEditDialog(record, 'edit')} disabled={!record.active || (employeeIsInactive && !allowInactiveEmployeeWrite)}>
              <Pencil className="mr-2 h-4 w-4" />
              Editar
            </Button>
            <Button type="button" variant="outline" onClick={() => openEditDialog(record, 'renew')} disabled={!record.active || (employeeIsInactive && !allowInactiveEmployeeWrite)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Renovar
            </Button>
            {canDeactivate && (
              <Button type="button" variant="outline" onClick={() => handleDeactivate(record)} disabled={!record.active} className="text-red-600 hover:text-red-700">
                <ShieldAlert className="mr-2 h-4 w-4" />
                Inativar
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-emerald-500" /></div>;
  }

  return (
    <div className="space-y-6" data-testid="employee-courses-section">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-bold text-slate-900">
            <GraduationCap className="h-5 w-5 text-emerald-600" />
            Cursos e Certificados
          </h3>
          <p className="mt-1 text-sm text-slate-500">Controle de cursos obrigatorios, certificados vigentes e historico do colaborador.</p>
        </div>
        {canManage && (
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button type="button" onClick={openCreateDialog} className="bg-emerald-500 hover:bg-emerald-600" disabled={employeeIsInactive && !allowInactiveEmployeeWrite}>
                <Plus className="mr-2 h-4 w-4" />
                Adicionar Curso
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>{dialogMode === 'create' ? 'Adicionar curso ao colaborador' : dialogMode === 'edit' ? 'Editar certificado' : 'Renovar certificado'}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">Curso</label>
                  {dialogMode === 'create' ? (
                    <select value={formData.course_id} onChange={(e) => setFormData((current) => ({ ...current, course_id: e.target.value }))} className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" required>
                      <option value="">Selecione um curso</option>
                      {activeCatalog.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
                    </select>
                  ) : (
                    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">{selectedRecord?.course_name || '-'}</div>
                  )}
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700">Data de inicio</label>
                    <input type="date" value={formData.start_date} onChange={(e) => setFormData((current) => ({ ...current, start_date: e.target.value }))} className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" required />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700">Data de validade</label>
                    <input type="date" value={formData.expiration_date} onChange={(e) => setFormData((current) => ({ ...current, expiration_date: e.target.value }))} className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" required />
                  </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700">Numero do certificado</label>
                    <input type="text" value={formData.certificate_number} onChange={(e) => setFormData((current) => ({ ...current, certificate_number: e.target.value }))} className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700">Instituicao / empresa</label>
                    <input type="text" value={formData.training_provider} onChange={(e) => setFormData((current) => ({ ...current, training_provider: e.target.value }))} className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">Observacoes</label>
                  <textarea value={formData.notes} onChange={(e) => setFormData((current) => ({ ...current, notes: e.target.value }))} className="min-h-[88px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">Anexo do certificado</label>
                  <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={(e) => setSelectedFile(e.target.files?.[0] || null)} className="block w-full text-sm text-slate-600 file:mr-4 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium" />
                  <p className="mt-1 text-xs text-slate-500">Formatos permitidos: PDF, JPG, JPEG e PNG.</p>
                </div>
                <div className="flex gap-3">
                  <Button type="submit" className="flex-1 bg-emerald-500 hover:bg-emerald-600" disabled={saving}>{saving ? 'Salvando...' : dialogMode === 'renew' ? 'Renovar certificado' : 'Salvar certificado'}</Button>
                  <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {!canManage && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">Seu perfil possui acesso somente para consulta nesta area.</div>
      )}

      {employeeIsInactive && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${allowInactiveEmployeeWrite ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
          {allowInactiveEmployeeWrite
            ? 'Colaborador inativo: somente administrador pode lancar ou renovar certificados por necessidade administrativa.'
            : 'Colaborador inativo: novos lancamentos e renovacoes estao bloqueados nesta fase, mas o historico permanece visivel.'}
        </div>
      )}

      {groupedRecords.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
          <GraduationCap className="mx-auto mb-3 h-10 w-10 text-slate-300" />
          <p className="font-medium text-slate-700">Nenhum curso vinculado ao colaborador</p>
          <p className="mt-1 text-sm text-slate-500">Cadastre certificados usando apenas cursos existentes no catalogo.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {groupedRecords.map((group) => (
            <div key={group.course_id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h4 className="text-base font-bold text-slate-900">{group.course_name}</h4>
                  <p className="text-sm text-slate-500">{group.history.length > 0 ? `${group.history.length + (group.current ? 1 : 0)} registro(s) preservados no historico` : '1 registro cadastrado'}</p>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  {group.current?.status === 'valid' && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                  {group.current?.status === 'expiring' && <Clock3 className="h-4 w-4 text-amber-600" />}
                  {group.current?.status === 'expired' && <AlertCircle className="h-4 w-4 text-red-600" />}
                  <span>{group.current ? 'Certificado vigente identificado automaticamente' : 'Sem certificado vigente ativo'}</span>
                </div>
              </div>
              {group.current && renderRecord(group.current)}
              {group.history.length > 0 && (
                <div className="mt-4 space-y-3 border-t border-slate-200 pt-4">
                  <p className="text-sm font-medium text-slate-700">Historico</p>
                  {group.history.map((record) => renderRecord(record, true))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
