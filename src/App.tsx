import React, { useState, useEffect, useRef } from 'react';
import { 
  Video, 
  Mic, 
  MicOff, 
  VideoOff, 
  PhoneOff, 
  MessageSquare, 
  Users, 
  FileText, 
  Send,
  Copy,
  Check,
  Sparkles,
  LayoutGrid,
  Monitor,
  MonitorOff
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import { cn } from './lib/utils';
import { generateMeetingMinutes } from './services/aiService';
import { Message, MeetingMinutes } from './types';

const socket = io({
  transports: ['websocket'],
  reconnectionAttempts: 5,
  timeout: 10000,
});

export default function App() {
  const [inMeeting, setInMeeting] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [peers, setPeers] = useState<any[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [showChat, setShowChat] = useState(false);
  const [showAI, setShowAI] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [minutes, setMinutes] = useState<MeetingMinutes | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [generatedLink, setGeneratedLink] = useState('');
  const [layout, setLayout] = useState<'grid' | 'focus'>('grid');
  const [isConnected, setIsConnected] = useState(socket.connected);
  const screenStreamRef = useRef<MediaStream | null>(null);

  const userVideo = useRef<HTMLVideoElement>(null);
  const peersRef = useRef<any[]>([]);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const onConnect = () => {
      console.log('Socket connected:', socket.id);
      setIsConnected(true);
    };
    const onDisconnect = () => {
      console.log('Socket disconnected');
      setIsConnected(false);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      setRoomId(roomParam);
      setInMeeting(true);
    }
  }, []);

  useEffect(() => {
    if (inMeeting) {
      const startMedia = async () => {
        let currentStream: MediaStream | null = null;
        
        try {
          if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
            throw new Error("Media devices API not supported");
          }

          const devices = await navigator.mediaDevices.enumerateDevices();
          const hasVideo = devices.some(device => device.kind === 'videoinput');
          const hasAudio = devices.some(device => device.kind === 'audioinput');

          if (hasVideo || hasAudio) {
            currentStream = await navigator.mediaDevices.getUserMedia({
              video: hasVideo,
              audio: hasAudio
            });
            setIsVideoOff(!hasVideo);
            setIsMuted(!hasAudio);
          } else {
            console.warn("No video or audio devices found");
            currentStream = new MediaStream();
            setIsVideoOff(true);
            setIsMuted(true);
          }
        } catch (err) {
          console.error("Error accessing media devices:", err);
          currentStream = new MediaStream();
          setIsVideoOff(true);
          setIsMuted(true);
        }

        setStream(currentStream);
        if (userVideo.current) {
          userVideo.current.srcObject = currentStream;
        }

        // Ensure socket is connected before joining
        if (!socket.connected) {
          await new Promise(resolve => {
            socket.once('connect', () => resolve(null));
          });
        }

        socket.emit('join-room', roomId);

        socket.on('all-users', (users: string[]) => {
          const peers: any[] = [];
          users.forEach((userId) => {
            const peer = createPeer(userId, socket.id!, currentStream);
            peersRef.current.push({
              peerId: userId,
              peer,
            });
            peers.push({
              peerId: userId,
              peer,
            });
          });
          setPeers(peers);
        });

        socket.on('user-joined', (payload: any) => {
          const peer = addPeer(payload.signal, payload.callerId, currentStream);
          peersRef.current.push({
            peerId: payload.callerId,
            peer,
          });
          setPeers((prev) => [...prev, { peerId: payload.callerId, peer }]);
        });

        socket.on('receiving-returned-signal', (payload: any) => {
          const item = peersRef.current.find((p) => p.peerId === payload.id);
          if (item) item.peer.signal(payload.signal);
        });

        socket.on('user-left', (id: string) => {
          const peerObj = peersRef.current.find((p) => p.peerId === id);
          if (peerObj) peerObj.peer.destroy();
          const peers = peersRef.current.filter((p) => p.peerId !== id);
          peersRef.current = peers;
          setPeers(peers);
        });

        socket.on('new-message', (msg: Message) => {
          setMessages((prev) => [...prev, msg]);
        });

        // Setup Speech Recognition for transcription
        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (SpeechRecognition) {
          const recognition = new SpeechRecognition();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.onresult = (event: any) => {
            let currentTranscript = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
              if (event.results[i].isFinal) {
                currentTranscript += event.results[i][0].transcript + ' ';
              }
            }
            if (currentTranscript) {
              setTranscript((prev) => prev + currentTranscript);
            }
          };
          recognition.start();
          recognitionRef.current = recognition;
        }
      };

      startMedia();
    }

    return () => {
      socket.off('all-users');
      socket.off('user-joined');
      socket.off('receiving-returned-signal');
      socket.off('user-left');
      socket.off('new-message');
      if (recognitionRef.current) recognitionRef.current.stop();
    };
  }, [inMeeting]);

  function createPeer(userToSignal: string, callerId: string, stream: MediaStream) {
    console.log(`Creating initiator peer for user: ${userToSignal}`);
    const peer = new Peer({
      initiator: true,
      trickle: false,
      stream,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
        ],
      },
    });

    peer.on('signal', (signal) => {
      console.log(`Sending signal to ${userToSignal}`);
      socket.emit('sending-signal', { userToSignal, callerId, signal });
    });

    peer.on('error', (err) => {
      console.error(`Peer error (initiator) with ${userToSignal}:`, err);
    });

    return peer;
  }

  function addPeer(incomingSignal: any, callerId: string, stream: MediaStream) {
    console.log(`Adding non-initiator peer for caller: ${callerId}`);
    const peer = new Peer({
      initiator: false,
      trickle: false,
      stream,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
        ],
      },
    });

    peer.on('signal', (signal) => {
      console.log(`Returning signal to ${callerId}`);
      socket.emit('returning-signal', { signal, callerId });
    });

    peer.on('error', (err) => {
      console.error(`Peer error (receiver) with ${callerId}:`, err);
    });

    peer.signal(incomingSignal);

    return peer;
  }

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomId.trim()) {
      setInMeeting(true);
    }
  };

  const handleCreate = () => {
    const newId = Math.random().toString(36).substring(2, 10);
    setRoomId(newId);
    setInMeeting(true);
  };

  const generateLink = () => {
    const newId = Math.random().toString(36).substring(2, 10);
    const url = `${window.location.origin}${window.location.pathname}?room=${newId}`;
    setGeneratedLink(url);
    setRoomId(newId);
  };

  const toggleMute = () => {
    if (stream && stream.getAudioTracks().length > 0) {
      const track = stream.getAudioTracks()[0];
      track.enabled = !track.enabled;
      setIsMuted(!track.enabled);
    }
  };

  const toggleVideo = () => {
    if (stream && stream.getVideoTracks().length > 0) {
      const track = stream.getVideoTracks()[0];
      track.enabled = !track.enabled;
      setIsVideoOff(!track.enabled);
    }
  };

  const toggleScreenShare = async () => {
    if (!isScreenSharing) {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        screenStreamRef.current = screenStream;
        const screenTrack = screenStream.getVideoTracks()[0];

        // Replace track for all peers
        peersRef.current.forEach(({ peer }) => {
          const videoTrack = stream?.getVideoTracks()[0];
          if (videoTrack) {
            peer.replaceTrack(videoTrack, screenTrack, stream!);
          }
        });

        // Update local video
        if (userVideo.current) {
          userVideo.current.srcObject = screenStream;
        }

        setIsScreenSharing(true);

        // Handle when user stops sharing via browser UI
        screenTrack.onended = () => {
          stopScreenShare();
        };
      } catch (error) {
        console.error("Error sharing screen:", error);
      }
    } else {
      stopScreenShare();
    }
  };

  const stopScreenShare = () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
    }
    
    const videoTrack = stream?.getVideoTracks()[0];
    const screenTrack = screenStreamRef.current?.getVideoTracks()[0];

    if (videoTrack && screenTrack) {
      peersRef.current.forEach(({ peer }) => {
        peer.replaceTrack(screenTrack, videoTrack, stream!);
      });
    }

    if (userVideo.current) {
      userVideo.current.srcObject = stream;
    }

    setIsScreenSharing(false);
    screenStreamRef.current = null;
  };

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputText.trim()) {
      socket.emit('send-message', { roomId, text: inputText });
      setInputText('');
    }
  };

  const handleGenerateMinutes = async () => {
    if (!transcript) return;
    setIsGenerating(true);
    const result = await generateMeetingMinutes(transcript);
    setMinutes(result);
    setIsGenerating(false);
    setShowAI(true);
  };

  const copyRoomId = () => {
    const url = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!inMeeting) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center p-6 font-sans">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full space-y-8 text-center"
        >
          <div className="flex justify-center">
            <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/20">
              <Video className="w-8 h-8" />
            </div>
          </div>
          
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tight">Lumina Meet</h1>
            <p className="text-gray-400">Professional video calls with AI-powered minutes.</p>
          </div>

          <div className="grid gap-4 pt-4">
            <button 
              onClick={handleCreate}
              className="w-full py-4 bg-blue-600 hover:bg-blue-700 rounded-xl font-semibold transition-all flex items-center justify-center gap-2"
            >
              <Video className="w-5 h-5" />
              New Meeting
            </button>

            <button 
              onClick={generateLink}
              className="w-full py-4 bg-gray-900 border border-gray-800 hover:bg-gray-800 rounded-xl font-semibold transition-all flex items-center justify-center gap-2"
            >
              <Sparkles className="w-5 h-5 text-purple-400" />
              Generate Meeting Link
            </button>

            <AnimatePresence>
              {generatedLink && (
                <motion.div 
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="bg-purple-900/10 border border-purple-500/20 rounded-xl p-4 space-y-3 overflow-hidden"
                >
                  <p className="text-xs text-purple-300 font-medium uppercase tracking-wider">Your Meeting Link</p>
                  <div className="flex gap-2">
                    <div className="flex-1 bg-black/40 rounded-lg px-3 py-2 text-xs font-mono text-gray-300 truncate border border-white/5">
                      {generatedLink}
                    </div>
                    <button 
                      onClick={() => {
                        navigator.clipboard.writeText(generatedLink);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                      className="p-2 bg-purple-600 hover:bg-purple-700 rounded-lg transition-all"
                    >
                      {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                  <button 
                    onClick={() => setInMeeting(true)}
                    className="w-full py-2 bg-white text-black hover:bg-gray-200 rounded-lg text-sm font-bold transition-all"
                  >
                    Join Now
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-gray-400 mb-2">
                <div className={cn(
                  "w-2 h-2 rounded-full",
                  isConnected ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" : "bg-red-500 animate-pulse"
                )} />
                {isConnected ? 'Connected to signaling server' : 'Connecting to server...'}
              </div>

              {!window.location.origin.includes('ais-pre') && (
                <div className="p-3 bg-amber-900/20 border border-amber-900/50 rounded-xl mb-4">
                  <p className="text-xs text-amber-500 leading-relaxed">
                    <strong>Note:</strong> You are using the development URL. To test with other devices, please use the <strong>Shared App URL</strong> from AI Studio.
                  </p>
                </div>
              )}

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-gray-800"></span>
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-[#0a0a0a] px-2 text-gray-500">Or join with a code</span>
                </div>
              </div>

              <form onSubmit={handleJoin} className="flex gap-2">
                <input 
                  type="text" 
                  placeholder="Enter meeting code"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  className="flex-1 bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                />
                <button 
                  type="submit"
                  className="px-6 bg-gray-800 hover:bg-gray-700 rounded-xl font-semibold transition-all"
                >
                  Join
                </button>
              </form>
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[#050505] text-white flex flex-col overflow-hidden font-sans">
      {/* Header */}
      <header className="h-16 border-b border-gray-900 flex items-center justify-between px-6 bg-[#0a0a0a]/80 backdrop-blur-md z-10">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <Video className="w-4 h-4" />
          </div>
          <div>
            <h2 className="font-semibold text-gray-200">Lumina Meet</h2>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 font-mono uppercase tracking-widest">Room: {roomId}</span>
              <div className={cn(
                "w-1.5 h-1.5 rounded-full",
                isConnected ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" : "bg-red-500 animate-pulse"
              )} />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button 
            onClick={() => setShowChat(!showChat)}
            className={cn(
              "p-2 rounded-lg transition-all relative",
              showChat ? "bg-blue-600 text-white" : "hover:bg-gray-800 text-gray-400"
            )}
          >
            <MessageSquare className="w-5 h-5" />
            {messages.length > 0 && !showChat && (
              <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" />
            )}
          </button>
          <button 
            onClick={() => setShowAI(!showAI)}
            className={cn(
              "p-2 rounded-lg transition-all",
              showAI ? "bg-purple-600 text-white" : "hover:bg-gray-800 text-gray-400"
            )}
          >
            <Sparkles className="w-5 h-5" />
          </button>
          <button 
            onClick={() => setShowParticipants(!showParticipants)}
            className={cn(
              "p-2 rounded-lg transition-all",
              showParticipants ? "bg-blue-600 text-white" : "hover:bg-gray-800 text-gray-400"
            )}
          >
            <Users className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden relative">
        <div className={cn(
          "flex-1 p-4 grid gap-4 auto-rows-fr",
          layout === 'grid' 
            ? `grid-cols-1 md:grid-cols-2 lg:grid-cols-${Math.min(3, Math.ceil(Math.sqrt(peers.length + 1)))}`
            : "grid-cols-1"
        )}>
          {/* User Video */}
          <div className="relative rounded-2xl overflow-hidden bg-gray-900 border border-gray-800 group shadow-2xl">
            <video 
              ref={userVideo} 
              autoPlay 
              muted 
              playsInline 
              className={cn("w-full h-full object-cover", isVideoOff && "hidden")} 
            />
            {isVideoOff && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
                <div className="w-24 h-24 rounded-full bg-gray-800 flex items-center justify-center text-3xl font-bold">
                  You
                </div>
              </div>
            )}
            <div className="absolute bottom-4 left-4 bg-black/50 backdrop-blur-md px-3 py-1 rounded-lg text-xs font-medium border border-white/10">
              You {isMuted && "(Muted)"}
            </div>
          </div>

          {/* Peer Videos */}
          {peers.map((peerObj) => (
            <VideoCard key={peerObj.peerId} peer={peerObj.peer} peerId={peerObj.peerId} />
          ))}
        </div>

        {/* Side Panels */}
        <AnimatePresence>
          {showChat && (
            <motion.aside 
              initial={{ x: 400 }}
              animate={{ x: 0 }}
              exit={{ x: 400 }}
              className="w-96 border-l border-gray-900 bg-[#0a0a0a] flex flex-col shadow-2xl"
            >
              <div className="p-4 border-b border-gray-900 flex items-center justify-between">
                <h3 className="font-semibold">In-call Messages</h3>
                <button onClick={() => setShowChat(false)} className="text-gray-500 hover:text-white">×</button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.map((msg, i) => (
                  <div key={i} className={cn(
                    "flex flex-col",
                    msg.sender === socket.id ? "items-end" : "items-start"
                  )}>
                    <span className="text-[10px] text-gray-500 mb-1">
                      {msg.sender === socket.id ? "You" : `User ${msg.sender.substring(0, 4)}`}
                    </span>
                    <div className={cn(
                      "px-4 py-2 rounded-2xl max-w-[85%] text-sm",
                      msg.sender === socket.id ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-200"
                    )}>
                      {msg.text}
                    </div>
                  </div>
                ))}
              </div>
              <form onSubmit={sendMessage} className="p-4 border-t border-gray-900 flex gap-2">
                <input 
                  type="text" 
                  placeholder="Send a message..."
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  className="flex-1 bg-gray-900 border border-gray-800 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button type="submit" className="p-2 bg-blue-600 rounded-xl hover:bg-blue-700 transition-all">
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </motion.aside>
          )}

          {showAI && (
            <motion.aside 
              initial={{ x: 400 }}
              animate={{ x: 0 }}
              exit={{ x: 400 }}
              className="w-96 border-l border-gray-900 bg-[#0a0a0a] flex flex-col shadow-2xl"
            >
              <div className="p-4 border-b border-gray-900 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-purple-400" />
                  <h3 className="font-semibold">AI Meeting Assistant</h3>
                </div>
                <button onClick={() => setShowAI(false)} className="text-gray-500 hover:text-white">×</button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-6">
                {!minutes ? (
                  <div className="space-y-4">
                    <div className="p-4 bg-purple-900/10 border border-purple-500/20 rounded-xl">
                      <p className="text-sm text-purple-200">
                        I'm listening to the meeting. Click below to generate professional minutes from the transcript.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Live Transcript</h4>
                      <div className="text-sm text-gray-400 leading-relaxed max-h-48 overflow-y-auto p-3 bg-gray-900/50 rounded-lg border border-gray-800 italic">
                        {transcript || "No speech detected yet..."}
                      </div>
                    </div>
                    <button 
                      onClick={handleGenerateMinutes}
                      disabled={!transcript || isGenerating}
                      className="w-full py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl font-semibold transition-all flex items-center justify-center gap-2"
                    >
                      {isGenerating ? (
                        <>
                          <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          <FileText className="w-4 h-4" />
                          Generate Minutes
                        </>
                      )}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <section className="space-y-2">
                      <h4 className="text-xs font-semibold text-purple-400 uppercase tracking-wider">Summary</h4>
                      <p className="text-sm text-gray-300 leading-relaxed">{minutes.summary}</p>
                    </section>
                    
                    <section className="space-y-2">
                      <h4 className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Action Items</h4>
                      <ul className="space-y-2">
                        {minutes.actionItems.map((item, i) => (
                          <li key={i} className="flex gap-3 text-sm text-gray-300">
                            <span className="w-5 h-5 rounded bg-blue-900/30 flex-shrink-0 flex items-center justify-center text-[10px] font-bold text-blue-400 border border-blue-500/20">
                              {i + 1}
                            </span>
                            {item}
                          </li>
                        ))}
                      </ul>
                    </section>

                    <section className="space-y-2">
                      <h4 className="text-xs font-semibold text-green-400 uppercase tracking-wider">Key Decisions</h4>
                      <ul className="space-y-2">
                        {minutes.keyDecisions.map((item, i) => (
                          <li key={i} className="flex gap-3 text-sm text-gray-300">
                            <div className="w-1.5 h-1.5 rounded-full bg-green-500 mt-1.5 flex-shrink-0" />
                            {item}
                          </li>
                        ))}
                      </ul>
                    </section>

                    <button 
                      onClick={() => setMinutes(null)}
                      className="w-full py-2 text-sm text-gray-500 hover:text-white transition-colors"
                    >
                      Reset and generate new
                    </button>
                  </div>
                )}
              </div>
            </motion.aside>
          )}

          {showParticipants && (
            <motion.aside 
              initial={{ x: 400 }}
              animate={{ x: 0 }}
              exit={{ x: 400 }}
              className="w-96 border-l border-gray-900 bg-[#0a0a0a] flex flex-col shadow-2xl"
            >
              <div className="p-4 border-b border-gray-900 flex items-center justify-between">
                <h3 className="font-semibold">Participants ({peers.length + 1})</h3>
                <button onClick={() => setShowParticipants(false)} className="text-gray-500 hover:text-white">×</button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                <div className="flex items-center justify-between p-3 bg-gray-900/50 rounded-xl border border-gray-800">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold">You</div>
                    <span className="text-sm font-medium">You (Host)</span>
                  </div>
                  <div className="flex gap-2">
                    {isMuted && <MicOff className="w-4 h-4 text-red-500" />}
                    {isVideoOff && <VideoOff className="w-4 h-4 text-red-500" />}
                  </div>
                </div>
                {peers.map((p) => (
                  <div key={p.peerId} className="flex items-center justify-between p-3 bg-gray-900/50 rounded-xl border border-gray-800">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-xs font-bold">
                        {p.peerId.substring(0, 2).toUpperCase()}
                      </div>
                      <span className="text-sm font-medium">User {p.peerId.substring(0, 4)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </main>

      {/* Controls */}
      <footer className="h-24 bg-[#0a0a0a] border-t border-gray-900 flex items-center justify-center px-6 gap-4 z-10">
        <div className="flex items-center gap-4">
          <button 
            onClick={toggleMute}
            className={cn(
              "w-12 h-12 rounded-full flex items-center justify-center transition-all border",
              isMuted ? "bg-red-500/10 border-red-500/50 text-red-500" : "bg-gray-800 border-gray-700 text-white hover:bg-gray-700"
            )}
          >
            {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>
          
          <button 
            onClick={toggleVideo}
            className={cn(
              "w-12 h-12 rounded-full flex items-center justify-center transition-all border",
              isVideoOff ? "bg-red-500/10 border-red-500/50 text-red-500" : "bg-gray-800 border-gray-700 text-white hover:bg-gray-700"
            )}
          >
            {isVideoOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
          </button>

          <button 
            onClick={toggleScreenShare}
            className={cn(
              "w-12 h-12 rounded-full flex items-center justify-center transition-all border",
              isScreenSharing ? "bg-blue-500/10 border-blue-500/50 text-blue-400" : "bg-gray-800 border-gray-700 text-white hover:bg-gray-700"
            )}
          >
            {isScreenSharing ? <MonitorOff className="w-5 h-5" /> : <Monitor className="w-5 h-5" />}
          </button>

          <button 
            onClick={() => setLayout(layout === 'grid' ? 'focus' : 'grid')}
            className="w-12 h-12 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center hover:bg-gray-700 transition-all"
          >
            <LayoutGrid className="w-5 h-5" />
          </button>

          <div className="w-[1px] h-8 bg-gray-800 mx-2" />

          <button 
            onClick={() => window.location.reload()}
            className="px-6 h-12 bg-red-600 hover:bg-red-700 rounded-full font-semibold flex items-center gap-2 transition-all shadow-lg shadow-red-500/20"
          >
            <PhoneOff className="w-5 h-5" />
            Leave
          </button>
        </div>
      </footer>
    </div>
  );
}

function VideoCard({ peer, peerId }: { peer: any, peerId: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [hasStream, setHasStream] = useState(false);

  useEffect(() => {
    const handleStream = (stream: MediaStream) => {
      console.log(`Received stream from ${peerId}`);
      if (ref.current) {
        ref.current.srcObject = stream;
        setHasStream(true);
      }
    };

    peer.on('stream', handleStream);
    
    // Check if peer already has a stream (some simple-peer versions)
    if (peer._remoteStream) {
      handleStream(peer._remoteStream);
    }

    return () => {
      peer.off('stream', handleStream);
    };
  }, [peer, peerId]);

  return (
    <div className="relative rounded-2xl overflow-hidden bg-gray-900 border border-gray-800 group shadow-2xl aspect-video">
      <video 
        ref={ref} 
        autoPlay 
        playsInline 
        className={cn("w-full h-full object-cover", !hasStream && "hidden")} 
      />
      {!hasStream && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
          <div className="flex flex-col items-center gap-3">
            <div className="w-16 h-16 rounded-full bg-gray-800 flex items-center justify-center text-xl font-bold animate-pulse">
              {peerId.substring(0, 2).toUpperCase()}
            </div>
            <span className="text-xs text-gray-500 font-medium">Connecting...</span>
          </div>
        </div>
      )}
      <div className="absolute bottom-4 left-4 bg-black/50 backdrop-blur-md px-3 py-1 rounded-lg text-xs font-medium border border-white/10">
        User {peerId.substring(0, 4)}
      </div>
    </div>
  );
}
