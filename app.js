/**
 * Dumb Charades — Bulletproof P2P Version
 * Fixes the "Missing Button" bug by using clear state phases.
 */

(function () {
  'use strict';

  // ---- Game State ----
  const state = {
    myName: '',
    roomCode: '',
    isHost: false,
    myId: null,
    players: [], // {id, name, score}
    settings: { difficulty: 'all', language: 'all', timer: 60 },
    
    // Game Flow
    phase: 'LOBBY', // LOBBY | PICKING | ACTING | RESULT | SCORES
    currentPlayerIndex: 0,
    currentMovie: null,
    timerDuration: 60,
    timerRemaining: 60,
    usedMovies: new Set(),
    
    // Result data
    lastResult: { actorName: '', movieTitle: '', guessed: false }
  };

  // ---- Utils ----
  function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  function showError(id, msg) {
    console.error('ERROR:', msg);
    const el = $(id);
    if (el) { el.textContent = msg; el.style.display = 'block'; setTimeout(() => el.style.display = 'none', 5000); }
  }

  function escapeHTML(str) {
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
  }


  // ---- P2P Variables ----
  let peer = null;
  let connections = []; // Host: connections to clients
  let hostConn = null;  // Client: connection to host

  // ---- DOM Elements ----
  const $ = (id) => document.getElementById(id);
  const screens = {
    home: $('screen-home'),
    lobby: $('screen-lobby'),
    actor: $('screen-actor'),
    guesser: $('screen-guesser'),
    turnResult: $('screen-turn-result'),
    scores: $('screen-scores'),
  };

  // ---- Initialization ----
  function init() {
    createParticles();
    bindEvents();
    console.log("🎬 Charades P2P Engine v2.0 Ready");
  }

  function createParticles() {
    const container = $('particles');
    for (let i = 0; i < 20; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      const size = Math.random() * 5 + 3;
      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.left = Math.random() * 100 + '%';
      p.style.animationDuration = (Math.random() * 10 + 10) + 's';
      p.style.animationDelay = (Math.random() * 5) + 's';
      container.appendChild(p);
    }
  }

  // ---- Logic: P2P Setup ----

  function initPeer(id = null, callback) {
    const peerId = id ? 'DC-' + id : null;
    peer = new Peer(peerId, { debug: 1 });

    peer.on('open', (id) => {
      state.myId = id;
      console.log("Peer opened with ID:", id);
      if (callback) callback();
    });

    peer.on('error', (err) => {
      console.error("PeerJS Error:", err);
      if (err.type === 'unavailable-id') {
        showError('home-error', "Room already exists or code invalid.");
      } else {
        showError('home-error', "Connection issue. Try refreshing.");
      }
    });

    peer.on('connection', (conn) => {
      if (!state.isHost) { conn.close(); return; }
      setupHostConnection(conn);
    });
  }

  function setupHostConnection(conn) {
    conn.on('open', () => {
      connections.push(conn);
      conn.on('data', (data) => handleIncomingData(conn, data));
      conn.on('close', () => {
        connections = connections.filter(c => c !== conn);
        state.players = state.players.filter(p => p.id !== conn.peer);
        broadcastState();
      });
    });
  }

  function setupClientConnection(conn) {
    hostConn = conn;
    conn.on('open', () => {
      conn.send({ type: 'JOIN', name: state.myName });
    });
    conn.on('data', (data) => handleIncomingData(conn, data));
    conn.on('close', () => {
      alert("Lost connection to host!");
      window.location.reload();
    });
  }

  // ---- Logic: Networking ----

  function handleIncomingData(conn, data) {
    console.log("Incoming Data:", data.type, data);

    if (state.isHost) {
      // Host side handling
      switch (data.type) {
        case 'JOIN':
          if (state.players.length >= 8) return;
          state.players.push({ id: conn.peer, name: data.name, score: 0 });
          broadcastState();
          break;
        case 'UPDATE_SETTINGS':
          state.settings = data.settings;
          broadcastState();
          break;
        case 'START_GAME':
          startGame();
          break;
        case 'GET_MOVIE':
          pickMovie();
          break;
        case 'ACTION':
          handleActorAction(data.action);
          break;
        case 'PLAY_AGAIN':
          resetToLobby();
          break;
      }
    } else {
      // Client side handling
      if (data.type === 'STATE_SYNC') {
        Object.assign(state, data.state);
        updateUI();
      }
      if (data.type === 'MOVIE_DATA') {
        state.currentMovie = data.movie;
        updateUI();
      }
    }
  }

  function broadcastState() {
    const sync = {
      type: 'STATE_SYNC',
      state: {
        players: state.players,
        settings: state.settings,
        phase: state.phase,
        currentPlayerIndex: state.currentPlayerIndex,
        timerRemaining: state.timerRemaining,
        timerDuration: state.timerDuration,
        lastResult: state.lastResult
      }
    };
    connections.forEach(c => c.send(sync));
    updateUI();
  }

  // ---- Logic: Game Flow (Host Only) ----

  let ticker = null;

  function startGame() {
    state.players.forEach(p => p.score = 0);
    state.currentPlayerIndex = 0;
    state.usedMovies = new Set();
    startRound();
  }

  function startRound() {
    state.currentMovie = null;
    state.phase = 'PICKING';
    state.timerRemaining = state.settings.timer;
    state.timerDuration = state.settings.timer;
    broadcastState();
  }

  function pickMovie() {
    const pool = MOVIES.filter(m => {
      if (state.usedMovies.has(m.title)) return false;
      if (state.settings.difficulty !== 'all' && m.difficulty !== state.settings.difficulty) return false;
      if (state.settings.language !== 'all' && m.language !== state.settings.language) return false;
      return true;
    });

    if (pool.length === 0) {
      alert("No more movies match these settings!");
      return;
    }

    const movie = pool[Math.floor(Math.random() * pool.length)];
    state.currentMovie = movie;
    state.usedMovies.add(movie.title);
    state.phase = 'ACTING';

    // Send movie only to the actor
    const actor = state.players[state.currentPlayerIndex];
    if (actor.id === state.myId) {
      // Host is actor
      updateUI();
    } else {
      const conn = connections.find(c => c.peer === actor.id);
      if (conn) conn.send({ type: 'MOVIE_DATA', movie });
    }

    // Start Timer
    if (ticker) clearInterval(ticker);
    broadcastState();
    
    ticker = setInterval(() => {
      state.timerRemaining--;
      if (state.timerRemaining <= 0) {
        clearInterval(ticker);
        handleActorAction('skip');
      } else {
        broadcastState();
      }
    }, 1000);
  }

  function handleActorAction(action) {
    if (ticker) clearInterval(ticker);
    const actor = state.players[state.currentPlayerIndex];
    const guessed = action === 'guessed';
    if (guessed) actor.score++;

    state.lastResult = {
      actorName: actor.name,
      movieTitle: state.currentMovie ? state.currentMovie.title : '???',
      guessed: guessed
    };

    state.phase = 'RESULT';
    broadcastState();

    setTimeout(() => {
      state.currentPlayerIndex++;
      if (state.currentPlayerIndex >= state.players.length) {
        state.phase = 'SCORES';
        broadcastState();
      } else {
        startRound();
      }
    }, 4000);
  }

  function resetToLobby() {
    state.phase = 'LOBBY';
    broadcastState();
  }

  // ---- Logic: UI ----

  function showScreen(id) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[id].classList.add('active');
  }

  function updateUI() {
    switch (state.phase) {
      case 'LOBBY':
        showLobby();
        break;
      case 'PICKING':
      case 'ACTING':
        showGameplay();
        break;
      case 'RESULT':
        showResult();
        break;
      case 'SCORES':
        showScores();
        break;
    }
  }

  function showLobby() {
    $('lobby-room-code').textContent = state.roomCode;
    renderPlayers('lobby-player-list');
    
    if (state.isHost) {
      $('lobby-settings').style.display = 'block';
      $('btn-start-game').style.display = 'block';
      $('btn-start-game').disabled = state.players.length < 2;
      $('lobby-waiting').style.display = 'none';
    } else {
      $('lobby-settings').style.display = 'none';
      $('btn-start-game').style.display = 'none';
      $('lobby-waiting').style.display = 'block';
    }
    showScreen('lobby');
  }

  function renderPlayers(listId) {
    const list = $(listId);
    list.innerHTML = '';
    state.players.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'player-item';
      const isMe = p.id === state.myId;
      li.innerHTML = `
        <span><b style="color:var(--accent-gold)">${i+1}</b> ${escapeHTML(p.name)} ${isMe ? '(You)' : ''}</span>
        ${i === 0 ? '<span class="host-badge">HOST</span>' : ''}
      `;
      list.appendChild(li);
    });
  }

  function showGameplay() {
    const actor = state.players[state.currentPlayerIndex];
    if (!actor) return;
    const isActor = actor.id === state.myId;

    if (isActor) {
      $('actor-name').textContent = actor.name;
      $('round-display').textContent = (state.currentPlayerIndex+1) + '/' + state.players.length;
      $('score-display').textContent = actor.score;
      
      if (state.phase === 'PICKING') {
        $('movie-prompt').style.display = 'block';
        $('movie-reveal').style.display = 'none';
        $('btn-get-movie').style.display = 'block';
        $('actor-actions').style.display = 'none';
        $('timer-container').style.display = 'none';
      } else {
        $('movie-prompt').style.display = 'none';
        $('movie-reveal').style.display = 'block';
        $('btn-get-movie').style.display = 'none';
        $('actor-actions').style.display = 'flex';
        $('timer-container').style.display = 'block';
        updateTimer('timer', state.timerDuration, state.timerRemaining);
        
        if (state.currentMovie) {
          $('movie-title').textContent = state.currentMovie.title;
          $('movie-year').textContent = state.currentMovie.year;
          $('movie-language').textContent = state.currentMovie.language;
          $('movie-difficulty').textContent = state.currentMovie.difficulty;
          $('movie-difficulty').className = 'movie-tag difficulty-' + state.currentMovie.difficulty;
        }
      }
      showScreen('actor');
    } else {
      // Guesser
      $('guesser-actor-name').textContent = actor.name;
      $('guesser-round').textContent = (state.currentPlayerIndex+1) + '/' + state.players.length;
      $('guesser-score').textContent = state.players.find(p => p.id === state.myId)?.score || 0;

      if (state.phase === 'PICKING') {
        $('guesser-waiting').style.display = 'block';
        $('guesser-timer-container').style.display = 'none';
      } else {
        $('guesser-waiting').style.display = 'none';
        $('guesser-timer-container').style.display = 'block';
        updateTimer('guesser-timer', state.timerDuration, state.timerRemaining);
      }
      showScreen('guesser');
    }
  }

  function updateTimer(prefix, duration, remaining) {
    const prog = $(prefix + '-progress');
    const text = $(prefix + '-text');
    const circumference = 2 * Math.PI * 90;
    
    prog.style.strokeDasharray = circumference;
    const offset = circumference - (remaining / duration) * circumference;
    prog.style.strokeDashoffset = offset;
    text.textContent = Math.ceil(remaining);

    if (remaining <= 10) {
      prog.classList.add('warning');
      text.classList.add('warning');
    } else {
      prog.classList.remove('warning');
      text.classList.remove('warning');
    }
  }

  function showResult() {
    $('result-icon').textContent = state.lastResult.guessed ? '🎉' : '⏰';
    $('result-title').textContent = state.lastResult.guessed ? 'Nailed it!' : 'Time\'s Up!';
    $('result-movie').textContent = `Movie: ${state.lastResult.movieTitle}`;
    $('result-next').textContent = `Actor: ${state.lastResult.actorName}`;
    showScreen('turnResult');
  }

  function showScores() {
    const sorted = [...state.players].sort((a,b) => b.score - a.score);
    const win = sorted[0];
    $('winner-text').textContent = win.score > 0 ? `${win.name} is the Winner! 🏆` : "Better luck next time! 😅";
    
    const list = $('score-list');
    list.innerHTML = '';
    sorted.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'score-item';
      li.innerHTML = `
        <div class="score-rank">${i+1}</div>
        <div class="score-info">
          <div class="score-player-name">${escapeHTML(p.name)}</div>
          <div class="score-details">${p.score} Movies Guessed</div>
        </div>
        <div class="score-points">${p.score}</div>
      `;
      list.appendChild(li);
    });

    if (state.isHost) {
      $('score-actions-host').style.display = 'flex';
      $('score-waiting').style.display = 'none';
    } else {
      $('score-actions-host').style.display = 'none';
      $('score-waiting').style.display = 'block';
    }
    showScreen('scores');
  }

  // ---- Logic: Events ----

  function bindEvents() {
    // Home
    $('btn-create-room').onclick = () => {
      const name = $('home-name').value.trim();
      if (!name) return alert("Enter name");
      state.myName = name;
      state.isHost = true;
      state.roomCode = generateCode();
      initPeer(state.roomCode, () => {
        state.players = [{ id: state.myId, name: state.myName, score: 0 }];
        showUI();
      });
    };

    $('btn-join-room').onclick = () => {
      const name = $('home-name').value.trim();
      const code = $('home-room-code').value.trim().toUpperCase();
      if (!name || !code) return alert("Fill all fields");
      state.myName = name;
      state.isHost = false;
      state.roomCode = code;
      initPeer(null, () => {
        const conn = peer.connect('DC-' + code);
        setupClientConnection(conn);
      });
    };

    // Lobby
    $('btn-start-game').onclick = () => { if (state.isHost) startGame(); };
    
    // Gameplay
    $('btn-get-movie').onclick = () => {
      if (state.isHost) pickMovie();
      else hostConn.send({ type: 'GET_MOVIE' });
    };

    $('btn-guessed').onclick = () => {
      if (state.isHost) handleActorAction('guessed');
      else hostConn.send({ type: 'ACTION', action: 'guessed' });
    };

    $('btn-skip').onclick = () => {
      if (state.isHost) handleActorAction('skip');
      else hostConn.send({ type: 'ACTION', action: 'skip' });
    };

    // Scores
    $('btn-play-again').onclick = () => {
      if (state.isHost) startGame();
      else hostConn.send({ type: 'PLAY_AGAIN' });
    };
    $('btn-back-lobby').onclick = () => {
      if (state.isHost) resetToLobby();
      else hostConn.send({ type: 'PLAY_AGAIN' });
    };

    // Utils
    $('btn-copy-code').onclick = () => {
      navigator.clipboard.writeText(state.roomCode).then(() => {
        $('btn-copy-code').textContent = '✅';
        setTimeout(() => $('btn-copy-code').textContent = '📋', 2000);
      });
    };

    // Settings
    bindPills('difficulty-pills', val => { 
      state.settings.difficulty = val; 
      if (state.isHost) broadcastState(); 
      else hostConn.send({type:'UPDATE_SETTINGS', settings: state.settings});
    });
    bindPills('language-pills', val => { 
      state.settings.language = val; 
      if (state.isHost) broadcastState(); 
      else hostConn.send({type:'UPDATE_SETTINGS', settings: state.settings});
    });
    bindPills('timer-pills', val => { 
      state.settings.timer = parseInt(val); 
      if (state.isHost) broadcastState(); 
      else hostConn.send({type:'UPDATE_SETTINGS', settings: state.settings});
    });
  }

  function bindPills(id, cb) {
    const el = $(id);
    el.onclick = (e) => {
      if (!e.target.classList.contains('pill')) return;
      el.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      e.target.classList.add('active');
      cb(e.target.dataset.value);
    };
  }

  function showUI() { updateUI(); }
  function showError(id, msg) { console.error(msg); const el = $(id); if(el) {el.textContent = msg; el.style.display = 'block';} }
  function escapeHTML(str) { const p = document.createElement('p'); p.textContent = str; return p.innerHTML; }

  document.addEventListener('DOMContentLoaded', init);
})();
