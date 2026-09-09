import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from './supabaseClient';
import type { VenueSettings, Court } from './types';

function AdminPage() {
  const navigate = useNavigate();

  const [settings, setSettings] = useState<VenueSettings>({
    warmupMinutes: 3,
    gameMinutes: 15,
    overtimeMinutes: 2,
  });
  const [courts, setCourts] = useState<Court[]>([]);
  const [newCourtName, setNewCourtName] = useState('');
  const [editingCourtId, setEditingCourtId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [courtError, setCourtError] = useState('');

  useEffect(() => {
    loadSettings();
    loadCourts();
  }, []);

  async function loadSettings() {
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) return;

    const { data, error } = await supabase
      .from('venue_settings')
      .select('*')
      .eq('owner_id', userId)
      .maybeSingle();

    if (error) console.error('Error loading venue settings:', error);

    if (data) {
      setSettings({
        warmupMinutes: data.warmup_minutes,
        gameMinutes: data.game_minutes,
        overtimeMinutes: data.overtime_minutes,
      });
    } else {
      const { error: createError } = await supabase.from('venue_settings').insert({
        owner_id: userId,
        warmup_minutes: 3,
        game_minutes: 15,
        overtime_minutes: 2,
      });
      if (createError) console.error('Error creating venue settings:', createError);
    }

    setIsLoading(false);
  }

  async function loadCourts() {
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) return;

    const { data, error } = await supabase
      .from('courts')
      .select('*')
      .eq('owner_id', userId)
      .order('id', { ascending: true });

    if (error) {
      console.error('Error loading courts:', error);
      return;
    }

    const mapped: Court[] = (data ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      players: [],
      startTime: c.start_time ? new Date(c.start_time).getTime() : null,
    }));

    const occupied = new Set(
      (data ?? []).filter((c) => (c.player_ids ?? []).length > 0).map((c) => c.id)
    );

    setCourts(mapped.map((c) => ({ ...c, players: occupied.has(c.id) ? [{ id: -1, name: '', partnerId: null }] : [] })));
  }

  async function handleSaveSettings() {
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) return;

    setIsSaving(true);
    setSaveMessage('');

    const { error } = await supabase
      .from('venue_settings')
      .update({
        warmup_minutes: settings.warmupMinutes,
        game_minutes: settings.gameMinutes,
        overtime_minutes: settings.overtimeMinutes,
      })
      .eq('owner_id', userId);

    setIsSaving(false);

    if (error) {
      console.error('Error saving venue settings:', error);
      setSaveMessage('Failed to save.');
      return;
    }

    setSaveMessage('Saved!');
    setTimeout(() => setSaveMessage(''), 2000);
  }

  async function handleAddCourt() {
    if (newCourtName.trim() === '') return;
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) return;

    const { error } = await supabase.from('courts').insert({
      owner_id: userId,
      name: newCourtName.trim(),
      player_ids: [],
      start_time: null,
    });

    if (error) {
      console.error('Error adding court:', error);
      return;
    }

    setNewCourtName('');
    loadCourts();
  }

  function startEditingCourt(court: Court) {
    setEditingCourtId(court.id);
    setEditingName(court.name);
  }

  async function handleRenameCourt(courtId: number) {
    if (editingName.trim() === '') return;

    const { error } = await supabase
      .from('courts')
      .update({ name: editingName.trim() })
      .eq('id', courtId);

    if (error) {
      console.error('Error renaming court:', error);
      return;
    }

    setEditingCourtId(null);
    loadCourts();
  }

  async function handleDeleteCourt(court: Court) {
    if (court.players.length > 0) return;

    const confirmed = window.confirm(`Remove "${court.name}"? This cannot be undone.`);
    if (!confirmed) return;

    setCourtError('');

    const { error } = await supabase.from('courts').delete().eq('id', court.id);

    if (error) {
      console.error('Error deleting court:', error);
      setCourtError('Failed to delete court.');
      return;
    }

    loadCourts();
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <p className="text-gray-400 text-sm">Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-linear-to-b from-slate-100 via-emerald-50 to-teal-100 px-4 py-8">
      <div className="max-w-lg mx-auto space-y-6">
        <button
          onClick={() => navigate('/dashboard')}
          className="text-gray-600 hover:text-gray-800 text-sm font-medium flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back to Dashboard
        </button>

        {/* Timer settings */}
        <div className="bg-white rounded-2xl shadow-xl p-6">
          <h1 className="text-xl font-extrabold text-gray-800 mb-1">Timer Settings</h1>
          <p className="text-sm text-gray-400 mb-6">
            Adjust timer lengths for every court. Changes apply the next time a court starts a new game.
          </p>

          <div className="space-y-5">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">
                Warmup (minutes)
              </label>
              <input
                type="number"
                min={0}
                step={0.5}
                value={settings.warmupMinutes}
                onChange={(e) =>
                  setSettings({ ...settings, warmupMinutes: parseFloat(e.target.value) || 0 })
                }
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">
                Game Time (minutes)
              </label>
              <input
                type="number"
                min={1}
                step={0.5}
                value={settings.gameMinutes}
                onChange={(e) =>
                  setSettings({ ...settings, gameMinutes: parseFloat(e.target.value) || 0 })
                }
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">
                Overtime Buffer (minutes)
              </label>
              <input
                type="number"
                min={0}
                step={0.5}
                value={settings.overtimeMinutes}
                onChange={(e) =>
                  setSettings({ ...settings, overtimeMinutes: parseFloat(e.target.value) || 0 })
                }
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 mt-6">
            <button
              onClick={handleSaveSettings}
              disabled={isSaving}
              className="bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white font-semibold text-sm px-5 py-2.5 rounded-lg transition-colors"
            >
              {isSaving ? 'Saving...' : 'Save Settings'}
            </button>
            {saveMessage && <span className="text-sm text-green-600 font-medium">{saveMessage}</span>}
          </div>
        </div>

        {/* Court management */}
        <div className="bg-white rounded-2xl shadow-xl p-6">
          <h2 className="text-xl font-extrabold text-gray-800 mb-1">Courts</h2>
          <p className="text-sm text-gray-400 mb-4">
            Add, rename, or remove courts. A court with an active game can't be removed until it's cleared.
          </p>

          {courtError && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-4">{courtError}</p>
          )}

          <ul className="space-y-2 mb-4">
            {courts.map((court) => {
              const isOccupied = court.players.length > 0;
              return (
                <li
                  key={court.id}
                  className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2"
                >
                  {editingCourtId === court.id ? (
                    <div className="flex items-center gap-2 flex-1">
                      <input
                        type="text"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRenameCourt(court.id);
                        }}
                        autoFocus
                        className="flex-1 border border-gray-200 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                      />
                      <button
                        onClick={() => handleRenameCourt(court.id)}
                        className="text-xs font-semibold bg-green-100 hover:bg-green-200 text-green-700 px-2.5 py-1 rounded-md transition-colors"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingCourtId(null)}
                        className="text-xs font-semibold bg-gray-200 hover:bg-gray-300 text-gray-700 px-2.5 py-1 rounded-md transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-800">{court.name}</span>
                        {isOccupied && (
                          <span className="text-[10px] font-bold bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                            IN USE
                          </span>
                        )}
                      </div>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => startEditingCourt(court)}
                          className="text-xs font-semibold bg-gray-200 hover:bg-gray-300 text-gray-700 px-2.5 py-1 rounded-md transition-colors"
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => handleDeleteCourt(court)}
                          disabled={isOccupied}
                          title={isOccupied ? 'Clear this court before removing it' : ''}
                          className="text-xs font-semibold bg-red-50 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed text-red-600 px-2.5 py-1 rounded-md transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newCourtName}
              onChange={(e) => setNewCourtName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddCourt();
              }}
              placeholder="New court name (e.g. Court 3)"
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <button
              onClick={handleAddCourt}
              className="bg-green-600 hover:bg-green-700 text-white font-semibold text-sm px-4 py-2 rounded-lg transition-colors"
            >
              Add Court
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AdminPage;