import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Button } from '@/components/ui/button';
import { API, withNoCache } from '@/config/api';
import { getAuthHeader } from '@/contexts/AuthContext';
import { CheckCircle2, Pencil, Plus, Trash2, UserCheck, XCircle } from 'lucide-react';

export default function AtendentesBalcao() {
  const [attendants, setAttendants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fullName, setFullName] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editingName, setEditingName] = useState('');

  const fetchAttendants = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`${API}/counter-attendants`, { headers: withNoCache(getAuthHeader()) });
      setAttendants(response.data || []);
    } catch (error) {
      console.error('Erro ao carregar atendentes:', error);
      toast.error('Erro ao carregar atendentes do balcão');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAttendants();
  }, []);

  const createAttendant = async (event) => {
    event.preventDefault();
    const name = fullName.trim();
    if (name.length < 3) {
      toast.error('Informe o nome completo do atendente.');
      return;
    }

    try {
      setSaving(true);
      await axios.post(`${API}/counter-attendants`, { full_name: name }, { headers: getAuthHeader() });
      setFullName('');
      toast.success('Atendente cadastrado');
      await fetchAttendants();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Erro ao cadastrar atendente');
    } finally {
      setSaving(false);
    }
  };

  const updateAttendant = async (id, data) => {
    try {
      setSaving(true);
      await axios.patch(`${API}/counter-attendants/${id}`, data, { headers: getAuthHeader() });
      setEditingId('');
      setEditingName('');
      await fetchAttendants();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Erro ao atualizar atendente');
    } finally {
      setSaving(false);
    }
  };

  const deleteAttendant = async (attendant) => {
    if (!window.confirm(`Excluir o atendente "${attendant.full_name}"?`)) return;
    try {
      setSaving(true);
      await axios.delete(`${API}/counter-attendants/${attendant.id}`, { headers: getAuthHeader() });
      toast.success('Atendente excluído');
      await fetchAttendants();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Erro ao excluir atendente');
    } finally {
      setSaving(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6" data-testid="counter-attendants-page">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Atendentes do Balcão</h1>
          <p className="mt-1 text-slate-600">Controle dos atendentes usados pelo terminal balcao_jac.</p>
        </div>

        <form onSubmit={createAttendant} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <label className="mb-2 block text-sm font-medium text-slate-700">Nome completo</label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              className="h-10 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              placeholder="Nome do atendente"
              data-testid="counter-attendant-name"
            />
            <Button type="submit" disabled={saving} className="bg-emerald-600 hover:bg-emerald-700">
              <Plus className="mr-2 h-4 w-4" />
              Cadastrar
            </Button>
          </div>
        </form>

        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
              <UserCheck className="h-5 w-5 text-emerald-600" />
              Atendentes cadastrados
            </h2>
          </div>

          {loading ? (
            <div className="p-8 text-center text-slate-500">Carregando...</div>
          ) : attendants.length === 0 ? (
            <div className="p-8 text-center text-slate-500">Nenhum atendente cadastrado</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {attendants.map((attendant) => (
                <div key={attendant.id} className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0 flex-1">
                    {editingId === attendant.id ? (
                      <input
                        value={editingName}
                        onChange={(event) => setEditingName(event.target.value)}
                        className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                      />
                    ) : (
                      <p className="font-semibold text-slate-900">{attendant.full_name}</p>
                    )}
                    <p className="text-sm text-slate-500">
                      Status: {attendant.is_active ? 'Ativo' : 'Inativo'}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {editingId === attendant.id ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => updateAttendant(attendant.id, { full_name: editingName.trim() })}
                          disabled={saving}
                        >
                          <CheckCircle2 className="mr-2 h-4 w-4" />
                          Salvar
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditingId('');
                            setEditingName('');
                          }}
                        >
                          Cancelar
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditingId(attendant.id);
                            setEditingName(attendant.full_name);
                          }}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          Editar
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => updateAttendant(attendant.id, { is_active: !attendant.is_active })}
                          disabled={saving}
                        >
                          {attendant.is_active ? (
                            <XCircle className="mr-2 h-4 w-4" />
                          ) : (
                            <CheckCircle2 className="mr-2 h-4 w-4" />
                          )}
                          {attendant.is_active ? 'Inativar' : 'Ativar'}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => deleteAttendant(attendant)}
                          disabled={saving}
                          className="text-red-600 hover:text-red-700"
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Excluir
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
