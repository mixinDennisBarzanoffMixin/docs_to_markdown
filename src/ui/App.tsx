import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { loadConfigFromEnv } from '../config';
import { BatchOrchestrator } from '../services/orchestrator';
import { loadState, resetInFlightToPending } from '../state';

export default function App() {
  const { exit } = useApp();
  
  // Load configuration from environment variables
  const config = useMemo(() => loadConfigFromEnv(), []);
  
  const abortController = useRef(new AbortController());
  const startedRef = useRef(false);

  // UI State
  const [phase, setPhase] = useState<'loading' | 'confirm' | 'running'>('loading');
  const [stats, setStats] = useState({ total: 0, ok: 0, fail: 0, pending: 0 });
  const [activeFiles, setActiveFiles] = useState<Set<string>>(new Set());

  /**
   * Refreshes stats from the local filesystem and state file.
   */
  const refresh = async () => {
    try {
      if (!existsSync(config.inputDir)) return;
      const all = await readdir(config.inputDir);
      const images = all.filter(f => /\.(jpg|jpeg|png|webp|heic|gif|bmp|tiff?)$/i.test(f));
      const state = await loadState(config.stateFile);
      
      // Clean up any files that were left in 'processing' state
      resetInFlightToPending(state);
      
      let ok = 0, fail = 0, pending = 0;
      for (const f of images) {
        const fs = state.files[f];
        if (!fs || fs.status === 'pending' || (fs.status === 'failed' && fs.attempts < 3)) {
          pending++;
        } else if (fs.status === 'completed') {
          ok++;
        } else {
          fail++;
        }
      }
      
      const newStats = { total: images.length, ok, fail, pending };
      setStats(newStats);
      return newStats;
    } catch (e) {
      // Silently fail on refresh errors
    }
  };

  /**
   * Starts the batch processing orchestrator.
   */
  const start = () => {
    if (startedRef.current) return;
    startedRef.current = true;
    
    setPhase('running');
    setActiveFiles(new Set());
    abortController.current = new AbortController();

    const orchestrator = new BatchOrchestrator(config, {
      abortSignal: abortController.current.signal,
      onEvent: (e) => {
        // Track which files are currently being processed
        if (e.type === 'file-start') {
          setActiveFiles(prev => new Set(prev).add(e.filename));
        }
        if (e.type === 'file-success' || e.type === 'file-failed') {
          setActiveFiles(prev => {
            const next = new Set(prev);
            next.delete(e.filename);
            return next;
          });
        }
        
        // Update stats in real-time as events come in from the orchestrator
        if ('stats' in e) {
          setStats({
            total: e.stats.discovered,
            ok: e.stats.completed,
            fail: e.stats.failed,
            pending: e.stats.pending,
          });
        }
        
        // Handle run completion
        if (e.type === 'run-finish') {
          startedRef.current = false;
          refresh().then(() => {
            setPhase('confirm');
            setActiveFiles(new Set());
          });
        }
      }
    });

    orchestrator.run().catch(() => {
      startedRef.current = false;
      setPhase('confirm');
    });
  };

  // Initial load
  useEffect(() => { 
    refresh().then((res) => {
      if (config.auto && res?.pending && res.pending > 0) {
        start();
      } else {
        setPhase('confirm');
      }
    }); 
  }, []);

  // Keyboard input handling
  useInput((input, key) => {
    if (phase === 'confirm') {
      if (input.toLowerCase() === 'y' || key.return) {
        stats.pending > 0 ? start() : exit();
      } else if (input.toLowerCase() === 'n' || key.escape || (key.ctrl && input === 'c')) {
        exit();
      } else if (input.toLowerCase() === 'a') {
        // Toggle auto mode locally
        config.auto = !config.auto;
        if (config.auto && stats.pending > 0) start();
      }
    } else if (phase === 'running' && key.ctrl && input === 'c') {
      abortController.current.abort();
      exit();
    }
  });

  const runningList = Array.from(activeFiles);

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="cyan">📄 DOCS TO MARKDOWN</Text>
        <Text dimColor>
          {config.auto ? <Text color="yellow">[AUTO MODE]</Text> : <Text color="blue">[MANUAL MODE]</Text>}
        </Text>
      </Box>
      <Text dimColor>{config.modelId} | Batch: {config.batchSize} | Conc: {config.concurrency}</Text>
      
      <Box marginY={1} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text>
          Total: {stats.total} | 
          <Text color="green"> OK: {stats.ok}</Text> | 
          <Text color="red"> FAIL: {stats.fail}</Text> | 
          <Text color="yellow"> PENDING: {stats.pending}</Text>
        </Text>
      </Box>

      {phase === 'running' ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="blue" bold>⚡ Processing...</Text>
          {runningList.length > 0 ? (
            runningList.map(f => (
              <Box key={f} marginLeft={2}>
                <Text>→ <Text color="white">{f}</Text></Text>
              </Box>
            ))
          ) : (
            <Box marginLeft={2}>
              <Text dimColor>Finishing...</Text>
            </Box>
          )}
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={1}>
          {stats.pending > 0 ? (
            <>
              <Text bold color="green">Press [Y] to run next batch</Text>
              <Text color="yellow">Press [A] to enable AUTO mode</Text>
              <Text dimColor>Press [N] or [Esc] to exit</Text>
            </>
          ) : (
            <Text color="green" bold>✅ All files processed!</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
