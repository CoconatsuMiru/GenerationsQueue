import { Link } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';

interface LandingPageProps {
  session: Session | null;
}

function LandingPage({ session }: LandingPageProps) {
  return (
    <div className="min-h-screen bg-linear-to-b from-slate-100 via-emerald-50 to-teal-100">
      <header className="max-w-6xl mx-auto px-6 py-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 bg-green-600 rounded-xl flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="9" />
              <path strokeLinecap="round" d="M8 12h8M12 8v8" />
            </svg>
          </div>
          <span className="text-xl font-extrabold text-gray-800">PickleQueue</span>
        </div>
        <Link
          to={session ? '/dashboard' : '/login'}
          className="bg-green-600 hover:bg-green-700 text-white font-semibold text-sm px-4 py-2 rounded-lg transition-colors"
        >
          {session ? 'Go to Dashboard' : 'Sign In'}
        </Link>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-20 text-center">
        <h1 className="text-4xl sm:text-5xl font-extrabold text-gray-800 tracking-tight mb-4">
          Run open play without the whiteboard.
        </h1>
        <p className="text-lg text-gray-500 max-w-xl mx-auto mb-8">
          PickleQueue auto-fills your courts, tracks game timers, and manages the waiting queue
          — so you can stop babysitting a clipboard and start playing.
        </p>
        <Link
          to={session ? '/dashboard' : '/login'}
          className="inline-block bg-green-600 hover:bg-green-700 text-white font-semibold px-6 py-3 rounded-lg shadow-sm transition-colors"
        >
          {session ? 'Go to Dashboard' : 'Get Started'}
        </Link>

        <div className="grid sm:grid-cols-3 gap-4 mt-16 text-left">
          {[
            ['Auto-Assign Courts', 'Players get placed into the next open court automatically, in fair queue order.'],
            ['Live Game Timers', 'Warmup, game time, and overtime buffers run per court so nobody loses track.'],
            ['Pairing & Queue Control', 'Pair doubles partners, skip, or remove players right from the sidebar.'],
          ].map(([title, desc]) => (
            <div key={title} className="bg-white/90 backdrop-blur rounded-xl shadow-sm p-5">
              <h3 className="font-bold text-gray-800 mb-1">{title}</h3>
              <p className="text-sm text-gray-500">{desc}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

export default LandingPage;