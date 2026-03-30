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
  MonitorOff,
  Hand,
  Smile,
  CircleDot,
  Download,
  StopCircle,
  RefreshCw,
  Pin,
  PinOff,
  LogOut
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
  const [isRecording, setIsRecording] = useState(false);
  const [isHandRaised, setIsHandRaised] = useState(false);
  const [reactions, setReactions] = useState<{ id: number, emoji: string, userId: string }[]>([]);
  const [raisedHands, setRaisedHands] = useState<Set<string>>(new Set());
  const [pinnedParticipantId, setPinnedParticipantId] = useState<string | null>(null);
  const [lastRoomId, setLastRoomId] = useState<string | null>(localStorage.getItem('lastRoomId'));
  const [meetingStartTime, setMeetingStartTime] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(40 * 60); // 40 minutes limit
  const [isAdvancedAudio, setIsAdvancedAudio] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);
  
  const screenStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  const userVideo = useRef<HTMLVideoElement>(null);
  const peersRef = useRef<any[]>([]);
  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const audioFilterRef = useRef<BiquadFilterNode | null>(null);
  const audioCompressorRef = useRef<DynamicsCompressorNode | null>(null);

  useEffect(() => {
    if (inMeeting && roomId) {
      const storedStartTime = localStorage.getItem(`meetingStart_${roomId}`);
      if (storedStartTime) {
        setMeetingStartTime(parseInt(storedStartTime));
      } else {
        const now = Date.now();
        setMeetingStartTime(now);
        localStorage.setItem(`meetingStart_${roomId}`, now.toString());
      }
    }
  }, [inMeeting, roomId]);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (inMeeting && meetingStartTime) {
      timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - meetingStartTime) / 1000);
        const remaining = Math.max(0, 40 * 60 - elapsed);
        setTimeLeft(remaining);

        if (remaining === 0) {
          setConfirmDialog({
            title: "Meeting Ended",
            message: "This meeting has reached its 40-minute time limit.",
            onConfirm: () => handleLeave()
          });
          clearInterval(timer);
        } else if (remaining === 60) {
          // 1 minute warning
          setConfirmDialog({
            title: "Meeting Ending Soon",
            message: "This meeting will end in 1 minute due to the time limit.",
            onConfirm: () => setConfirmDialog(null)
          });
        }
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [inMeeting, meetingStartTime]);

  useEffect(() => {
    const itemsPerPage = 9;
    const totalParticipants = peers.length + 1;
    const totalPages = Math.ceil(totalParticipants / itemsPerPage);
    if (currentPage >= totalPages && totalPages > 0) {
      setCurrentPage(Math.max(0, totalPages - 1));
    }
  }, [peers.length, currentPage]);

  const applyAdvancedAudio = (stream: MediaStream) => {
    if (!isAdvancedAudio) return stream;

    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      
      // Clean up previous nodes
      if (audioSourceRef.current) audioSourceRef.current.disconnect();
      if (audioFilterRef.current) audioFilterRef.current.disconnect();
      if (audioCompressorRef.current) audioCompressorRef.current.disconnect();

      const source = ctx.createMediaStreamSource(stream);
      const destination = ctx.createMediaStreamDestination();
      
      // High-pass filter to remove low-end noise/rumble
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 150; // Cut off frequencies below 150Hz
      
      // Compressor to normalize volume and reduce peaks
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-24, ctx.currentTime);
      compressor.knee.setValueAtTime(40, ctx.currentTime);
      compressor.ratio.setValueAtTime(12, ctx.currentTime);
      compressor.attack.setValueAtTime(0, ctx.currentTime);
      compressor.release.setValueAtTime(0.25, ctx.currentTime);

      source.connect(filter);
      filter.connect(compressor);
      compressor.connect(destination);

      audioSourceRef.current = source;
      audioFilterRef.current = filter;
      audioCompressorRef.current = compressor;
      audioDestinationRef.current = destination;

      // Combine processed audio with original video
      const processedStream = new MediaStream([
        ...stream.getVideoTracks(),
        ...destination.stream.getAudioTracks()
      ]);

      return processedStream;
    } catch (err) {
      console.error("Error applying advanced audio:", err);
      return stream;
    }
  };

  useEffect(() => {
    if (stream && isAdvancedAudio) {
      const processed = applyAdvancedAudio(stream);
      // We don't update the main stream state here to avoid infinite loops,
      // but we update the peers' tracks.
      peersRef.current.forEach(({ peer }) => {
        const oldAudioTrack = stream.getAudioTracks()[0];
        const newAudioTrack = processed.getAudioTracks()[0];
        if (oldAudioTrack && newAudioTrack) {
          peer.replaceTrack(oldAudioTrack, newAudioTrack, stream);
        }
      });
    } else if (stream && !isAdvancedAudio) {
      // Revert to original audio
      peersRef.current.forEach(({ peer }) => {
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
          // Find the track currently being sent and replace it
          // This is a bit tricky with simple-peer if we don't track the "current" track sent.
          // But usually replacing with the original stream track works.
          peer.replaceTrack(peer.streams[0].getAudioTracks()[0], audioTrack, stream);
        }
      });
    }
  }, [isAdvancedAudio]);

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
      localStorage.setItem('lastRoomId', roomParam);
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
              video: hasVideo ? {
                facingMode: 'user',
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 24 }
              } : false,
              audio: hasAudio ? {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
              } : false
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
            // Check if peer already exists
            if (peersRef.current.find(p => p.peerId === userId)) return;

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
          setPeers(prev => {
            const existingIds = new Set(prev.map(p => p.peerId));
            const newPeers = peers.filter(p => !existingIds.has(p.peerId));
            return [...prev, ...newPeers];
          });
        });

        socket.on('user-joined', (payload: any) => {
          // Check if peer already exists
          if (peersRef.current.find(p => p.peerId === payload.callerId)) return;

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

        socket.on('user-hand-raise', ({ userId, isHandRaised }: { userId: string, isHandRaised: boolean }) => {
          setRaisedHands((prev) => {
            const next = new Set(prev);
            if (isHandRaised) {
              next.add(userId);
            } else {
              next.delete(userId);
            }
            return next;
          });
        });

        socket.on('new-reaction', ({ userId, emoji }: { userId: string, emoji: string }) => {
          const id = Date.now();
          setReactions((prev) => [...prev, { id, emoji, userId }]);
          setTimeout(() => {
            setReactions((prev) => prev.filter((r) => r.id !== id));
          }, 3000);
        });

        socket.on('host-action', ({ action }: { action: 'mute-all' | 'stop-video-all' | 'end-meeting' }) => {
          if (action === 'mute-all') {
            setIsMuted(true);
            if (stream) {
              stream.getAudioTracks().forEach(track => track.enabled = false);
            }
          } else if (action === 'stop-video-all') {
            setIsVideoOff(true);
            if (stream) {
              stream.getVideoTracks().forEach(track => track.enabled = false);
            }
          } else if (action === 'end-meeting') {
            setConfirmDialog({
              title: "Meeting Ended",
              message: "The host has ended the meeting for everyone.",
              onConfirm: () => handleLeave()
            });
          }
        });

        socket.on('room-info', ({ hostId }: { hostId: string }) => {
          setIsHost(socket.id === hostId);
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
      socket.off('user-hand-raise');
      socket.off('new-reaction');
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

  const handleCreate = () => {
    const newId = Math.random().toString(36).substring(2, 10);
    setRoomId(newId);
    setInMeeting(true);
    localStorage.setItem('lastRoomId', newId);
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomId.trim()) {
      setInMeeting(true);
      localStorage.setItem('lastRoomId', roomId);
    }
  };

  const handleRejoin = () => {
    if (lastRoomId) {
      setRoomId(lastRoomId);
      setInMeeting(true);
    }
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

  const refreshMedia = async () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
    
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasVideo = devices.some(device => device.kind === 'videoinput');
      const hasAudio = devices.some(device => device.kind === 'audioinput');

      const newStream = await navigator.mediaDevices.getUserMedia({
        video: hasVideo ? {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 }
        } : false,
        audio: hasAudio
      });

      setStream(newStream);
      if (userVideo.current) {
        userVideo.current.srcObject = newStream;
      }

      // Update tracks for all peers
      peersRef.current.forEach(({ peer }) => {
        const oldVideoTrack = stream?.getVideoTracks()[0];
        const newVideoTrack = newStream.getVideoTracks()[0];
        if (oldVideoTrack && newVideoTrack) {
          peer.replaceTrack(oldVideoTrack, newVideoTrack, newStream);
        }

        const oldAudioTrack = stream?.getAudioTracks()[0];
        const newAudioTrack = newStream.getAudioTracks()[0];
        if (oldAudioTrack && newAudioTrack) {
          peer.replaceTrack(oldAudioTrack, newAudioTrack, newStream);
        }
      });
    } catch (err) {
      console.error("Error refreshing media:", err);
    }
  };

  const toggleHandRaise = () => {
    const newState = !isHandRaised;
    setIsHandRaised(newState);
    socket.emit('hand-raise', { roomId, isHandRaised: newState });
  };

  const muteAll = () => {
    if (!isHost) return;
    socket.emit('host-action', { roomId, action: 'mute-all' });
  };

  const stopVideoAll = () => {
    if (!isHost) return;
    socket.emit('host-action', { roomId, action: 'stop-video-all' });
  };

  const endMeetingForAll = () => {
    if (!isHost) return;
    setConfirmDialog({
      title: "End Meeting for All?",
      message: "This will disconnect everyone from the meeting.",
      onConfirm: () => {
        socket.emit('host-action', { roomId, action: 'end-meeting' });
        handleLeave();
      }
    });
  };

  const sendReaction = (emoji: string) => {
    socket.emit('reaction', { roomId, emoji });
  };

  const startRecording = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });
      
      const recorder = new MediaRecorder(screenStream, { mimeType: 'video/webm' });
      mediaRecorderRef.current = recorder;
      recordedChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `lumina-meet-recording-${new Date().toISOString()}.webm`;
        a.click();
        URL.revokeObjectURL(url);
        setIsRecording(false);
        screenStream.getTracks().forEach(track => track.stop());
      };

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Error starting recording:", err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  const toggleScreenShare = async () => {
    if (!isScreenSharing) {
      setConfirmDialog({
        title: "Start Screen Sharing?",
        message: "This will replace your camera feed with your screen for all participants.",
        onConfirm: async () => {
          setConfirmDialog(null);
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
              stopScreenShare(false); // No confirm if stopped by browser
            };
          } catch (error) {
            console.error("Error sharing screen:", error);
          }
        }
      });
    } else {
      setConfirmDialog({
        title: "Stop Screen Sharing?",
        message: "Your camera feed will be restored.",
        onConfirm: () => {
          setConfirmDialog(null);
          stopScreenShare(false);
        }
      });
    }
  };

  const stopScreenShare = (shouldConfirm = true) => {
    const executeStop = () => {
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

    if (shouldConfirm) {
      setConfirmDialog({
        title: "Stop Screen Sharing?",
        message: "Your camera feed will be restored.",
        onConfirm: () => {
          setConfirmDialog(null);
          executeStop();
        }
      });
    } else {
      executeStop();
    }
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

  const handleLeave = () => {
    window.location.reload();
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (!inMeeting) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center lg:justify-center justify-start pt-12 lg:pt-0 p-6 font-sans overflow-y-auto">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full space-y-6 lg:space-y-8 text-center"
        >
          <div className="flex justify-center">
            <div className="w-12 h-12 lg:w-16 lg:h-16 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/20">
              <Video className="w-6 h-6 lg:w-8 lg:h-8" />
            </div>
          </div>
          
          <div className="space-y-2">
            <h1 className="text-3xl lg:text-4xl font-bold tracking-tight">Lumina Meet</h1>
            <p className="text-sm lg:text-base text-gray-400">Professional video calls with AI-powered minutes.</p>
          </div>

          <div className="grid gap-3 lg:gap-4 pt-4">
            <button 
              onClick={handleCreate}
              className="w-full py-3 lg:py-4 bg-blue-600 hover:bg-blue-700 rounded-xl font-semibold transition-all flex items-center justify-center gap-2"
            >
              <Video className="w-5 h-5" />
              New Meeting
            </button>

            {lastRoomId && (
              <button 
                onClick={handleRejoin}
                className="w-full py-3 lg:py-4 bg-green-600/10 border border-green-500/20 hover:bg-green-600/20 text-green-400 rounded-xl font-semibold transition-all flex items-center justify-center gap-2"
              >
                <RefreshCw className="w-5 h-5" />
                <span className="truncate">Rejoin ({lastRoomId})</span>
              </button>
            )}

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
      <header className="h-14 md:h-16 border-b border-gray-900 flex items-center justify-between px-4 md:px-6 bg-[#0a0a0a]/80 backdrop-blur-md z-10">
        <div className="flex items-center gap-2 md:gap-4">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
            <Video className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-gray-200 text-sm md:text-base truncate">Lumina Meet</h2>
            <div className="flex items-center gap-2">
              <span className="text-[9px] md:text-[10px] text-gray-500 font-mono uppercase tracking-widest truncate max-w-[80px] md:max-w-none">Room: {roomId}</span>
              <div className={cn(
                "w-1.5 h-1.5 rounded-full shrink-0",
                isConnected ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" : "bg-red-500 animate-pulse"
              )} />
            </div>
          </div>
          {meetingStartTime && (
            <div className={cn(
              "ml-2 md:ml-4 px-2 md:px-3 py-1 rounded-full text-[10px] md:text-xs font-bold font-mono flex items-center gap-1.5 md:gap-2 border",
              timeLeft < 300 ? "bg-red-500/10 border-red-500/50 text-red-500 animate-pulse" : "bg-gray-800 border-gray-700 text-gray-400"
            )}>
              <CircleDot className={cn("w-2.5 h-2.5 md:w-3 md:h-3", timeLeft < 300 ? "text-red-500" : "text-gray-500")} />
              {formatTime(timeLeft)}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 md:gap-3">
          <button 
            onClick={refreshMedia}
            className="p-2 rounded-lg transition-all hover:bg-gray-800 text-gray-400 hidden sm:block"
            title="Refresh Camera/Mic"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
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
          "flex-1 p-2 md:p-4 flex flex-col overflow-hidden",
        )}>
          <div className={cn(
            "flex-1 grid gap-2 md:gap-4 overflow-y-auto",
            pinnedParticipantId 
              ? "grid-cols-1 lg:grid-cols-[1fr_300px]" 
              : layout === 'grid' 
                ? `grid-cols-${Math.min(peers.length + 1, 2) > 1 ? '2' : '1'} md:grid-cols-2 lg:grid-cols-${Math.min(3, Math.ceil(Math.sqrt(Math.min(peers.length + 1, 9))))}`
                : "grid-cols-1"
          )}>
            {/* Main Video Area (Pinned or Grid) */}
            <div className={cn(
              "grid gap-4",
              pinnedParticipantId ? "grid-cols-1" : "contents"
            )}>
              {pinnedParticipantId ? (
                // Render pinned participant
                peers.find(p => p.peerId === pinnedParticipantId) ? (
                  <VideoCard 
                    key={pinnedParticipantId} 
                    peer={peers.find(p => p.peerId === pinnedParticipantId).peer} 
                    peerId={pinnedParticipantId} 
                    isHandRaised={raisedHands.has(pinnedParticipantId)}
                    isPinned={true}
                    onPin={() => setPinnedParticipantId(null)}
                  />
                ) : (
                  // If pinned user left, reset
                  (() => { setPinnedParticipantId(null); return null; })()
                )
              ) : (
                // Normal Grid View with Pagination
                <>
                  {(() => {
                    const allParticipants = [
                      { id: 'me', isMe: true },
                      ...peers.map(p => ({ id: p.peerId, isMe: false, peer: p.peer }))
                    ];
                    const itemsPerPage = 9;
                    const totalPages = Math.ceil(allParticipants.length / itemsPerPage);
                    const startIdx = currentPage * itemsPerPage;
                    const pageItems = allParticipants.slice(startIdx, startIdx + itemsPerPage);

                    return (
                      <>
                        {pageItems.map((item) => (
                          item.isMe ? (
                            <div key="me" className="relative rounded-2xl overflow-hidden bg-gray-900 border border-gray-800 group shadow-2xl aspect-video">
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
                              {isHandRaised && (
                                <div className="absolute top-4 right-4 bg-yellow-500 text-black p-2 rounded-full shadow-lg animate-bounce">
                                  <Hand className="w-4 h-4" />
                                </div>
                              )}
                            </div>
                          ) : (
                            <VideoCard 
                              key={item.id} 
                              peer={(item as any).peer} 
                              peerId={item.id} 
                              isHandRaised={raisedHands.has(item.id)}
                              isPinned={false}
                              onPin={() => setPinnedParticipantId(item.id)}
                            />
                          )
                        ))}
                        
                        {totalPages > 1 && (
                          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-4 bg-black/60 backdrop-blur-md px-4 py-2 rounded-full border border-white/10 z-20">
                            <button 
                              disabled={currentPage === 0}
                              onClick={() => setCurrentPage(prev => prev - 1)}
                              className="p-1 hover:bg-white/10 rounded-full disabled:opacity-30"
                            >
                              <RefreshCw className="w-4 h-4 rotate-180" />
                            </button>
                            <span className="text-xs font-medium">Page {currentPage + 1} of {totalPages}</span>
                            <button 
                              disabled={currentPage === totalPages - 1}
                              onClick={() => setCurrentPage(prev => prev + 1)}
                              className="p-1 hover:bg-white/10 rounded-full disabled:opacity-30"
                            >
                              <RefreshCw className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </>
              )}
            </div>
          </div>

          {/* Sidebar for other participants when pinned */}
          {pinnedParticipantId && (
            <div className="hidden lg:flex flex-col gap-4 overflow-y-auto pr-2">
              {/* User Video in Sidebar */}
              <div className="relative rounded-xl overflow-hidden bg-gray-900 border border-gray-800 group shadow-lg aspect-video shrink-0">
                <video 
                  ref={userVideo} 
                  autoPlay 
                  muted 
                  playsInline 
                  className={cn("w-full h-full object-cover", isVideoOff && "hidden")} 
                />
                {isVideoOff && (
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
                    <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center text-sm font-bold">
                      You
                    </div>
                  </div>
                )}
                <div className="absolute bottom-2 left-2 bg-black/50 backdrop-blur-md px-2 py-0.5 rounded text-[10px] font-medium border border-white/10">
                  You
                </div>
              </div>

              {/* Other Peers in Sidebar */}
              {peers.filter(p => p.peerId !== pinnedParticipantId).map((peerObj) => (
                <VideoCard 
                  key={peerObj.peerId} 
                  peer={peerObj.peer} 
                  peerId={peerObj.peerId} 
                  isHandRaised={raisedHands.has(peerObj.peerId)}
                  isPinned={false}
                  onPin={() => setPinnedParticipantId(peerObj.peerId)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Floating Reactions */}
        <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden">
          <AnimatePresence>
            {reactions.map((reaction) => (
              <motion.div
                key={reaction.id}
                initial={{ y: '100vh', x: `${Math.random() * 80 + 10}vw`, opacity: 0, scale: 0.5 }}
                animate={{ y: '-10vh', opacity: 1, scale: 1.5 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 3, ease: "easeOut" }}
                className="absolute text-2xl md:text-4xl"
              >
                {reaction.emoji}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Side Panels */}
        <AnimatePresence>
          {showChat && (
            <motion.aside 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              className="fixed inset-0 lg:relative lg:inset-auto lg:w-96 border-l border-gray-900 bg-[#0a0a0a] flex flex-col shadow-2xl z-50"
            >
              <div className="p-4 border-b border-gray-900 flex items-center justify-between">
                <h3 className="font-semibold">In-call Messages</h3>
                <button onClick={() => setShowChat(false)} className="p-2 text-gray-500 hover:text-white text-2xl">×</button>
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
              <form onSubmit={sendMessage} className="p-4 pb-8 lg:pb-4 border-t border-gray-900 flex gap-2">
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
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              className="fixed inset-0 lg:relative lg:inset-auto lg:w-96 border-l border-gray-900 bg-[#0a0a0a] flex flex-col shadow-2xl z-50"
            >
              <div className="p-4 border-b border-gray-900 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-purple-400" />
                  <h3 className="font-semibold">AI Assistant</h3>
                </div>
                <button onClick={() => setShowAI(false)} className="p-2 text-gray-500 hover:text-white text-2xl">×</button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-6 pb-20 lg:pb-4">
                {!minutes ? (
                  <div className="space-y-4">
                    <div className="p-4 bg-purple-900/10 border border-purple-500/20 rounded-xl">
                      <p className="text-sm text-purple-200">
                        I'm listening. Generate professional minutes from the transcript.
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
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              className="fixed inset-0 lg:relative lg:inset-auto lg:w-96 border-l border-gray-900 bg-[#0a0a0a] flex flex-col shadow-2xl z-50"
            >
              <div className="p-4 border-b border-gray-900 flex items-center justify-between">
                <h3 className="font-semibold">Participants ({peers.length + 1})</h3>
                <button onClick={() => setShowParticipants(false)} className="p-2 text-gray-500 hover:text-white text-2xl">×</button>
              </div>
              
              {isHost && (
                <div className="p-4 border-b border-gray-900 grid grid-cols-3 gap-2">
                  <button 
                    onClick={muteAll}
                    className="flex flex-col items-center gap-1 p-2 rounded-lg bg-gray-900 hover:bg-gray-800 transition-colors border border-gray-800"
                  >
                    <MicOff className="w-4 h-4 text-red-500" />
                    <span className="text-[10px] text-gray-400">Mute All</span>
                  </button>
                  <button 
                    onClick={stopVideoAll}
                    className="flex flex-col items-center gap-1 p-2 rounded-lg bg-gray-900 hover:bg-gray-800 transition-colors border border-gray-800"
                  >
                    <VideoOff className="w-4 h-4 text-red-500" />
                    <span className="text-[10px] text-gray-400">Stop Video</span>
                  </button>
                  <button 
                    onClick={endMeetingForAll}
                    className="flex flex-col items-center gap-1 p-2 rounded-lg bg-red-900/10 hover:bg-red-900/20 transition-colors border border-red-900/30"
                  >
                    <PhoneOff className="w-4 h-4 text-red-500" />
                    <span className="text-[10px] text-red-400">End All</span>
                  </button>
                </div>
              )}

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
      <footer className="h-20 md:h-24 bg-[#0a0a0a] border-t border-gray-900 flex items-center justify-center px-4 md:px-6 gap-2 md:gap-4 z-10">
        <div className="flex items-center gap-2 md:gap-3 lg:gap-4">
          <button 
            onClick={toggleMute}
            className={cn(
              "w-10 h-10 md:w-12 md:h-12 rounded-full flex items-center justify-center transition-all border",
              isMuted ? "bg-red-500/10 border-red-500/50 text-red-500" : "bg-gray-800 border-gray-700 text-white hover:bg-gray-700"
            )}
          >
            {isMuted ? <MicOff className="w-4 h-4 md:w-5 md:h-5" /> : <Mic className="w-4 h-4 md:w-5 md:h-5" />}
          </button>
          
          <button 
            onClick={toggleVideo}
            className={cn(
              "w-10 h-10 md:w-12 md:h-12 rounded-full flex items-center justify-center transition-all border",
              isVideoOff ? "bg-red-500/10 border-red-500/50 text-red-500" : "bg-gray-800 border-gray-700 text-white hover:bg-gray-700"
            )}
          >
            {isVideoOff ? <VideoOff className="w-4 h-4 md:w-5 md:h-5" /> : <Video className="w-4 h-4 md:w-5 md:h-5" />}
          </button>

          <button 
            onClick={toggleScreenShare}
            className={cn(
              "w-10 h-10 md:w-12 md:h-12 rounded-full flex items-center justify-center transition-all border hidden sm:flex",
              isScreenSharing ? "bg-blue-500/10 border-blue-500/50 text-blue-400" : "bg-gray-800 border-gray-700 text-white hover:bg-gray-700"
            )}
          >
            {isScreenSharing ? <MonitorOff className="w-4 h-4 md:w-5 md:h-5" /> : <Monitor className="w-4 h-4 md:w-5 md:h-5" />}
          </button>

          <button 
            onClick={toggleHandRaise}
            className={cn(
              "w-10 h-10 md:w-12 md:h-12 rounded-full flex items-center justify-center transition-all border",
              isHandRaised ? "bg-yellow-500/10 border-yellow-500/50 text-yellow-500" : "bg-gray-800 border-gray-700 text-white hover:bg-gray-700"
            )}
          >
            <Hand className="w-4 h-4 md:w-5 md:h-5" />
          </button>

          <div className="relative group/reactions">
            <button className="w-10 h-10 md:w-12 md:h-12 rounded-full bg-gray-800 border border-gray-700 text-white flex items-center justify-center hover:bg-gray-700 transition-all">
              <Smile className="w-4 h-4 md:w-5 md:h-5" />
            </button>
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 p-2 bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl flex gap-1 md:gap-2 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-active:opacity-100 group-active:pointer-events-auto transition-all">
              {['❤️', '👍', '🎉', '👏', '😮', '🔥'].map(emoji => (
                <button 
                  key={emoji}
                  onClick={() => sendReaction(emoji)}
                  className="w-8 h-8 md:w-10 md:h-10 flex items-center justify-center hover:bg-gray-800 rounded-xl transition-all text-lg md:text-xl"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          <button 
            onClick={() => setIsAdvancedAudio(!isAdvancedAudio)}
            className={cn(
              "w-10 h-10 md:w-12 md:h-12 rounded-full flex items-center justify-center transition-all border",
              isAdvancedAudio ? "bg-purple-500/10 border-purple-500/50 text-purple-400" : "bg-gray-800 border-gray-700 text-white hover:bg-gray-700"
            )}
            title={isAdvancedAudio ? "Disable Advanced Audio" : "Enable Advanced Audio (Noise Cancellation)"}
          >
            <Sparkles className="w-4 h-4 md:w-5 md:h-5" />
          </button>

          <button 
            onClick={handleLeave}
            className="w-10 h-10 md:w-12 md:h-12 rounded-full bg-red-600 flex items-center justify-center hover:bg-red-700 transition-all shadow-lg shadow-red-900/20"
          >
            <LogOut className="w-4 h-4 md:w-5 md:h-5" />
          </button>
        </div>
      </footer>

      {/* Confirmation Dialog */}
      <AnimatePresence>
        {confirmDialog && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-gray-900 border border-gray-800 rounded-3xl p-6 max-w-sm w-full shadow-2xl"
            >
              <h3 className="text-xl font-bold mb-2">{confirmDialog.title}</h3>
              <p className="text-gray-400 text-sm mb-6 leading-relaxed">
                {confirmDialog.message}
              </p>
              <div className="flex gap-3">
                <button 
                  onClick={() => setConfirmDialog(null)}
                  className="flex-1 py-3 rounded-xl bg-gray-800 hover:bg-gray-700 font-medium transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={confirmDialog.onConfirm}
                  className="flex-1 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 font-medium transition-colors"
                >
                  Confirm
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function VideoCard({ 
  peer, 
  peerId, 
  isHandRaised, 
  isPinned, 
  onPin 
}: { 
  peer: any, 
  peerId: string, 
  isHandRaised?: boolean,
  isPinned: boolean,
  onPin: () => void
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [hasStream, setHasStream] = useState(false);
  const [isLocalMuted, setIsLocalMuted] = useState(false);
  const [isLocalVideoOff, setIsLocalVideoOff] = useState(false);
  const [showControls, setShowControls] = useState(false);

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
    <div 
      onClick={() => setShowControls(!showControls)}
      className={cn(
        "relative rounded-2xl overflow-hidden bg-gray-900 border border-gray-800 group shadow-2xl aspect-video transition-all duration-300 cursor-pointer",
        isPinned && "ring-2 ring-blue-500"
      )}
    >
      <video 
        ref={ref} 
        autoPlay 
        playsInline 
        muted={isLocalMuted}
        className={cn("w-full h-full object-cover pointer-events-none", (!hasStream || isLocalVideoOff) && "hidden")} 
      />
      
      {(!hasStream || isLocalVideoOff) && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900 pointer-events-none">
          <div className="flex flex-col items-center gap-3">
            <div className="w-12 h-12 md:w-16 md:h-16 rounded-full bg-gray-800 flex items-center justify-center text-lg md:text-xl font-bold animate-pulse">
              {peerId.substring(0, 2).toUpperCase()}
            </div>
            <span className="text-[10px] md:text-xs text-gray-500 font-medium">
              {!hasStream ? "Connecting..." : "Video Paused"}
            </span>
          </div>
        </div>
      )}

      {/* Local Controls Overlay */}
      <div 
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "absolute top-2 left-2 md:top-4 md:left-4 flex gap-1 md:gap-2 transition-opacity duration-200",
          showControls ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        )}
      >
        <button 
          onClick={() => setIsLocalMuted(!isLocalMuted)}
          className={cn(
            "p-1.5 md:p-2 rounded-lg backdrop-blur-md border transition-all",
            isLocalMuted ? "bg-red-500/20 border-red-500/50 text-red-500" : "bg-black/40 border-white/10 text-white hover:bg-black/60"
          )}
          title={isLocalMuted ? "Unmute participant" : "Mute participant"}
        >
          {isLocalMuted ? <MicOff className="w-3.5 h-3.5 md:w-4 md:h-4" /> : <Mic className="w-3.5 h-3.5 md:w-4 md:h-4" />}
        </button>
        <button 
          onClick={() => setIsLocalVideoOff(!isLocalVideoOff)}
          className={cn(
            "p-1.5 md:p-2 rounded-lg backdrop-blur-md border transition-all",
            isLocalVideoOff ? "bg-red-500/20 border-red-500/50 text-red-500" : "bg-black/40 border-white/10 text-white hover:bg-black/60"
          )}
          title={isLocalVideoOff ? "Show video" : "Hide video"}
        >
          {isLocalVideoOff ? <VideoOff className="w-3.5 h-3.5 md:w-4 md:h-4" /> : <Video className="w-3.5 h-3.5 md:w-4 md:h-4" />}
        </button>
        <button 
          onClick={onPin}
          className={cn(
            "p-1.5 md:p-2 rounded-lg backdrop-blur-md border transition-all",
            isPinned ? "bg-blue-500/20 border-blue-500/50 text-blue-500" : "bg-black/40 border-white/10 text-white hover:bg-black/60"
          )}
          title={isPinned ? "Unpin participant" : "Pin participant"}
        >
          {isPinned ? <PinOff className="w-3.5 h-3.5 md:w-4 md:h-4" /> : <Pin className="w-3.5 h-3.5 md:w-4 md:h-4" />}
        </button>
      </div>

      <div className="absolute bottom-2 left-2 md:bottom-4 md:left-4 bg-black/50 backdrop-blur-md px-2 py-0.5 md:px-3 md:py-1 rounded-lg text-[10px] md:text-xs font-medium border border-white/10 flex items-center gap-1 md:gap-2 pointer-events-none">
        <span className="truncate max-w-[80px] md:max-w-[100px]">User {peerId.substring(0, 4)}</span>
        {isLocalMuted && <MicOff className="w-3 h-3 text-red-500" />}
        {isPinned && <Pin className="w-3 h-3 text-blue-500" />}
      </div>

      {isHandRaised && (
        <div className="absolute top-2 right-2 md:top-4 md:right-4 bg-yellow-500 text-black p-1.5 md:p-2 rounded-full shadow-lg animate-bounce pointer-events-none">
          <Hand className="w-3.5 h-3.5 md:w-4 md:h-4" />
        </div>
      )}
    </div>
  );
}
