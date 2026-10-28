import React, { useEffect, useMemo, useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Plus, Search, GraduationCap, Edit2, Link2, ToggleLeft, ToggleRight } from 'lucide-react';
import axios from 'axios';
import { getAuthHeader, useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { API } from '@/config/api';

const normalizeText = (value) => (value ? String(value).trim().replace(/\s+/g, ' ') : '');

const createEmptyFormData = () => ({
  name: '',
  description: '',
  active: true,
  block_epi_delivery: false,
  alert_days_before_expiration: 0,
  epi_ids: []
});

export default function Cursos() {
  const { user } = useAuth();
  const [courses, setCourses] = useState([]);
  const [epis, setEpis] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [editingCourse, setEditingCourse] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [epiSearchTerm, setEpiSearchTerm] = useState('');
  const [formData, setFormData] = useState(createEmptyFormData());

  const canManageCourses = user?.role === 'admin' || user?.role === 'seguranca_trabalho';
  const isReadOnly = !canManageCourses;

  const epiOptions = useMemo(() => (
    epis
      .map((epi) => ({
        id: epi.id,
        name: epi.epi_group_name || epi.name || 'EPI sem nome',
        category: epi.category || epi.type_category || '',
        groupKey: epi.epi_group_key || '',
        subtitle: [epi.category || epi.type_category, epi.model, epi.brand].filter(Boolean).join(' • ')
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  ), [epis]);

  const filteredCourses = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return courses.filter((course) => (
      course.name?.toLowerCase().includes(term) ||
      course.description?.toLowerCase().includes(term)
    ));
  }, [courses, searchTerm]);

  const filteredEpis = useMemo(() => {
    const term = epiSearchTerm.toLowerCase();
    return epiOptions.filter((epi) => (
      epi.name.toLowerCase().includes(term) ||
      epi.category.toLowerCase().includes(term) ||
      epi.subtitle.toLowerCase().includes(term)
    ));
  }, [epiOptions, epiSearchTerm]);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [coursesRes, episRes] = await Promise.all([
        axios.get(`${API}/courses`, { headers: getAuthHeader() }),
        axios.get(`${API}/epis`, { headers: getAuthHeader() })
      ]);
      setCourses(coursesRes.data);
      setEpis(episRes.data);
    } catch (error) {
      console.error('Erro ao carregar cursos:', error);
      toast.error(error.response?.data?.detail || 'Erro ao carregar cursos');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setFormData(createEmptyFormData());
    setEditingCourse(null);
    setEpiSearchTerm('');
  };

  const openCreateDialog = () => {
    resetForm();
    setShowDialog(true);
  };

  const openEditDialog = async (course) => {
    try {
      const response = await axios.get(`${API}/courses/${course.id}`, { headers: getAuthHeader() });
      const courseData = response.data;
      setEditingCourse(courseData);
      setFormData({
        name: courseData.name || '',
        description: courseData.description || '',
        active: courseData.active !== false,
        block_epi_delivery: !!courseData.block_epi_delivery,
        alert_days_before_expiration: Number(courseData.alert_days_before_expiration || 0),
        epi_ids: (courseData.linked_epis || []).map((item) => item.epi_id)
      });
      setEpiSearchTerm('');
      setShowDialog(true);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Erro ao carregar curso');
    }
  };

  const toggleSelectedEpi = (epiId) => {
    setFormData((current) => ({
      ...current,
      epi_ids: current.epi_ids.includes(epiId)
        ? current.epi_ids.filter((id) => id !== epiId)
        : [...current.epi_ids, epiId]
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);

    const payload = {
      name: normalizeText(formData.name),
      description: normalizeText(formData.description) || null,
      active: !!formData.active,
      block_epi_delivery: !!formData.block_epi_delivery,
      alert_days_before_expiration: Number(formData.alert_days_before_expiration || 0),
      epi_ids: formData.epi_ids
    };

    try {
      if (editingCourse) {
        await axios.patch(`${API}/courses/${editingCourse.id}`, payload, { headers: getAuthHeader() });
        toast.success('Curso atualizado com sucesso');
      } else {
        await axios.post(`${API}/courses`, payload, { headers: getAuthHeader() });
        toast.success('Curso cadastrado com sucesso');
      }
      setShowDialog(false);
      resetForm();
      fetchData();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Erro ao salvar curso');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (course) => {
    if (isReadOnly) return;
    try {
      await axios.patch(
        `${API}/courses/${course.id}`,
        { active: !course.active },
        { headers: getAuthHeader() }
      );
      toast.success(`Curso ${course.active ? 'inativado' : 'ativado'} com sucesso`);
      fetchData();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Erro ao atualizar status');
    }
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-500"></div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6" data-testid="cursos-page">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">Cursos</h1>
            <p className="mt-1 text-slate-600">
              Catálogo de cursos, regras de bloqueio e vínculo com EPIs.
            </p>
          </div>
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Buscar curso"
                className="h-10 w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 text-sm sm:w-72"
              />
            </div>
            {canManageCourses && (
              <Dialog
                open={showDialog}
                onOpenChange={(open) => {
                  setShowDialog(open);
                  if (!open) resetForm();
                }}
              >
                <DialogTrigger asChild>
                  <Button onClick={openCreateDialog} className="bg-emerald-500 hover:bg-emerald-600">
                    <Plus className="mr-2 h-4 w-4" />
                    Novo Curso
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>{editingCourse ? 'Editar Curso' : 'Novo Curso'}</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={handleSubmit} className="space-y-5">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="md:col-span-2">
                        <label className="mb-1 block text-sm font-medium text-slate-700">Nome do curso *</label>
                        <input
                          type="text"
                          required
                          value={formData.name}
                          onChange={(event) => setFormData({ ...formData, name: event.target.value })}
                          className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                          placeholder="Ex.: NR35"
                        />
                      </div>

                      <div className="md:col-span-2">
                        <label className="mb-1 block text-sm font-medium text-slate-700">Descrição</label>
                        <textarea
                          value={formData.description}
                          onChange={(event) => setFormData({ ...formData, description: event.target.value })}
                          className="min-h-[88px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                          placeholder="Ex.: Trabalho em altura"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-sm font-medium text-slate-700">Bloquear retirada de EPI</label>
                        <select
                          value={formData.block_epi_delivery ? 'true' : 'false'}
                          onChange={(event) => setFormData({ ...formData, block_epi_delivery: event.target.value === 'true' })}
                          className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                        >
                          <option value="true">Sim</option>
                          <option value="false">Não</option>
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block text-sm font-medium text-slate-700">Dias de alerta</label>
                        <input
                          type="number"
                          min="0"
                          value={formData.alert_days_before_expiration}
                          onChange={(event) => setFormData({ ...formData, alert_days_before_expiration: event.target.value })}
                          className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-sm font-medium text-slate-700">Status</label>
                        <select
                          value={formData.active ? 'true' : 'false'}
                          onChange={(event) => setFormData({ ...formData, active: event.target.value === 'true' })}
                          className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                        >
                          <option value="true">Ativo</option>
                          <option value="false">Inativo</option>
                        </select>
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200">
                      <div className="border-b border-slate-200 p-4">
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                          <div>
                            <h3 className="font-semibold text-slate-900">EPIs vinculados</h3>
                            <p className="text-sm text-slate-500">
                              Selecione um ou mais EPIs sem alterar estoque, CA ou variações.
                            </p>
                          </div>
                          <div className="relative">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                            <input
                              type="text"
                              value={epiSearchTerm}
                              onChange={(event) => setEpiSearchTerm(event.target.value)}
                              placeholder="Buscar EPI"
                              className="h-10 w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 text-sm md:w-72"
                            />
                          </div>
                        </div>
                      </div>
                      <div className="max-h-72 space-y-2 overflow-y-auto p-4">
                        {filteredEpis.length === 0 && (
                          <p className="text-sm text-slate-500">Nenhum EPI encontrado.</p>
                        )}
                        {filteredEpis.map((epi) => (
                          <label
                            key={epi.id}
                            className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 p-3 hover:border-emerald-300 hover:bg-emerald-50/40"
                          >
                            <input
                              type="checkbox"
                              checked={formData.epi_ids.includes(epi.id)}
                              onChange={() => toggleSelectedEpi(epi.id)}
                              className="mt-1 h-4 w-4 rounded border-slate-300 text-emerald-600"
                            />
                            <div className="min-w-0">
                              <p className="font-medium text-slate-900">{epi.name}</p>
                              <p className="text-sm text-slate-500">{epi.subtitle || epi.category || 'Sem categoria'}</p>
                              <p className="text-xs text-slate-400">ID: {epi.id}</p>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="flex gap-3">
                      <Button type="submit" disabled={saving} className="flex-1 bg-emerald-500 hover:bg-emerald-600">
                        {saving ? 'Salvando...' : editingCourse ? 'Salvar alterações' : 'Cadastrar curso'}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => setShowDialog(false)}>
                        Cancelar
                      </Button>
                    </div>
                  </form>
                </DialogContent>
              </Dialog>
            )}
          </div>
        </div>

        {isReadOnly && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Seu perfil possui acesso somente para consulta neste módulo.
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm text-slate-500">Cursos cadastrados</p>
            <p className="mt-2 text-3xl font-bold text-slate-900">{courses.length}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm text-slate-500">Cursos ativos</p>
            <p className="mt-2 text-3xl font-bold text-emerald-600">
              {courses.filter((course) => course.active).length}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm text-slate-500">EPIs vinculados</p>
            <p className="mt-2 text-3xl font-bold text-slate-900">
              {courses.reduce((total, course) => total + Number(course.linked_epis_count || 0), 0)}
            </p>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Curso</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Bloqueia retirada</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Dias alerta</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">EPIs vinculados</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredCourses.length === 0 && (
                  <tr>
                    <td colSpan="6" className="px-4 py-10 text-center text-sm text-slate-500">
                      Nenhum curso encontrado.
                    </td>
                  </tr>
                )}
                {filteredCourses.map((course) => (
                  <tr key={course.id} className="align-top">
                    <td className="px-4 py-4">
                      <div className="flex items-start gap-3">
                        <div className="rounded-lg bg-emerald-50 p-2 text-emerald-600">
                          <GraduationCap className="h-5 w-5" />
                        </div>
                        <div>
                          <p className="font-semibold text-slate-900">{course.name}</p>
                          <p className="mt-1 text-sm text-slate-500">{course.description || 'Sem descrição'}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                        course.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-700'
                      }`}>
                        {course.active ? 'Ativo' : 'Inativo'}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-sm text-slate-700">{course.block_epi_delivery ? 'Sim' : 'Não'}</td>
                    <td className="px-4 py-4 text-sm text-slate-700">{course.alert_days_before_expiration}</td>
                    <td className="px-4 py-4">
                      <div className="space-y-2">
                        <div className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                          <Link2 className="h-3.5 w-3.5" />
                          {course.linked_epis_count || 0} EPIs
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {(course.linked_epis || []).slice(0, 3).map((epi) => (
                            <span key={`${course.id}-${epi.epi_id}`} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600">
                              {epi.name}
                            </span>
                          ))}
                          {(course.linked_epis || []).length > 3 && (
                            <span className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-500">
                              +{course.linked_epis.length - 3}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex justify-end gap-2">
                        {canManageCourses ? (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              className="border-slate-200"
                              onClick={() => openEditDialog(course)}
                            >
                              <Edit2 className="mr-2 h-4 w-4" />
                              Editar
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              className="border-slate-200"
                              onClick={() => handleToggleActive(course)}
                            >
                              {course.active ? (
                                <ToggleRight className="mr-2 h-4 w-4 text-emerald-600" />
                              ) : (
                                <ToggleLeft className="mr-2 h-4 w-4 text-slate-500" />
                              )}
                              {course.active ? 'Inativar' : 'Ativar'}
                            </Button>
                          </>
                        ) : (
                          <span className="text-sm text-slate-500">Somente leitura</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
