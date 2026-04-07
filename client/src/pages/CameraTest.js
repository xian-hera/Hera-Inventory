import React, { useState, useEffect, useRef } from 'react';
import { BrowserMultiFormatReader, NotFoundException } from '@zxing/library';

function CameraTest() {
  const [scanning, setScanning]     = useState(false);
  const [result, setResult]         = useState('');
  const [error, setError]           = useState('');
  const [lastScans, setLastScans]   = useState([]);

  const videoRef    = useRef(null);
  const canvasRef   = useRef(null);
  const readerRef   = useRef(null);
  const rafRef      = useRef(null);
  const streamRef   = useRef(null);
  const scanningRef = useRef(false);

  // 清理函数
  const stopCamera = () => {
    scanningRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setScanning(false);
  };

  useEffect(() => {
    return () => stopCamera();
  }, []);

  const startCamera = async () => {
    setError('');
    setResult('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setScanning(true);
      scanningRef.current = true;
      readerRef.current = new BrowserMultiFormatReader();
      scanFrame();
    } catch (e) {
      setError('Camera error: ' + e.message);
    }
  };

  const scanFrame = () => {
    if (!scanningRef.current) return;
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(scanFrame);
      return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    canvas.width  = vw;
    canvas.height = vh;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, vw, vh);

    // 只取中央长条区域：宽度 80%，高度 20%
    const roiW = Math.floor(vw * 0.8);
    const roiH = Math.floor(vh * 0.2);
    const roiX = Math.floor((vw - roiW) / 2);
    const roiY = Math.floor((vh - roiH) / 2);

    const roiCanvas = document.createElement('canvas');
    roiCanvas.width  = roiW;
    roiCanvas.height = roiH;
    roiCanvas.getContext('2d').drawImage(canvas, roiX, roiY, roiW, roiH, 0, 0, roiW, roiH);

    try {
      const res = readerRef.current.decodeFromCanvas(roiCanvas);
      const text = res.getText();
      setResult(text);
      setLastScans(prev => [
        { text, time: new Date().toLocaleTimeString() },
        ...prev.slice(0, 9),
      ]);
      // 成功后暂停 1.5 秒再继续，避免重复读取
      setTimeout(() => {
        if (scanningRef.current) rafRef.current = requestAnimationFrame(scanFrame);
      }, 1500);
    } catch (e) {
      if (!(e instanceof NotFoundException)) {
        console.warn('Scan error:', e);
      }
      rafRef.current = requestAnimationFrame(scanFrame);
    }
  };

  // 计算取景框中央长条的位置（用于 UI overlay）
  // 长条：宽 80%，高 20%，居中
  const overlayStyle = {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none',
  };

  return (
    <div style={{ maxWidth: '480px', margin: '0 auto', padding: '16px', fontFamily: 'sans-serif' }}>
      <h2 style={{ marginBottom: '16px' }}>📷 Camera Scan Test</h2>

      {error && (
        <div style={{ background: '#fff4f4', border: '1px solid #d72c0d', borderRadius: '8px',
          padding: '12px', marginBottom: '12px', color: '#d72c0d', fontSize: '14px' }}>
          {error}
        </div>
      )}

      {/* 取景区域 */}
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9',
        background: '#000', borderRadius: '12px', overflow: 'hidden', marginBottom: '12px' }}>
        <video ref={videoRef} style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          playsInline muted />
        <canvas ref={canvasRef} style={{ display: 'none' }} />

        {/* Overlay：上下左右暗色遮罩 + 中央透明长条 */}
        {scanning && (
          <div style={overlayStyle}>
            {/* 上方遮罩 */}
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '40%',
              background: 'rgba(0,0,0,0.5)' }} />
            {/* 下方遮罩 */}
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '40%',
              background: 'rgba(0,0,0,0.5)' }} />
            {/* 左侧遮罩 */}
            <div style={{ position: 'absolute', top: '40%', left: 0, width: '10%', height: '20%',
              background: 'rgba(0,0,0,0.5)' }} />
            {/* 右侧遮罩 */}
            <div style={{ position: 'absolute', top: '40%', right: 0, width: '10%', height: '20%',
              background: 'rgba(0,0,0,0.5)' }} />
            {/* 中央识别框边框 */}
            <div style={{
              position: 'absolute', top: '40%', left: '10%', right: '10%', height: '20%',
              border: '2px solid #00e676', borderRadius: '4px',
              boxShadow: '0 0 0 1px rgba(0,230,118,0.3)',
            }}>
              {/* 扫描线动画 */}
              <div style={{
                position: 'absolute', left: 0, right: 0, height: '2px',
                background: 'rgba(0,230,118,0.8)',
                animation: 'scanline 1.5s ease-in-out infinite',
              }} />
            </div>
            <style>{`
              @keyframes scanline {
                0%   { top: 0; }
                50%  { top: calc(100% - 2px); }
                100% { top: 0; }
              }
            `}</style>
          </div>
        )}

        {/* 未开始时的提示 */}
        {!scanning && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center', color: '#6d7175', fontSize: '14px' }}>
            Press Start to open camera
          </div>
        )}
      </div>

      {/* 控制按钮 */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {!scanning ? (
          <button onClick={startCamera} style={{
            flex: 1, padding: '12px', borderRadius: '8px', border: 'none',
            background: '#008060', color: 'white', fontSize: '16px',
            fontWeight: '600', cursor: 'pointer',
          }}>
            Start
          </button>
        ) : (
          <button onClick={stopCamera} style={{
            flex: 1, padding: '12px', borderRadius: '8px', border: 'none',
            background: '#d72c0d', color: 'white', fontSize: '16px',
            fontWeight: '600', cursor: 'pointer',
          }}>
            Stop
          </button>
        )}
      </div>

      {/* 最新扫描结果 */}
      {result && (
        <div style={{ background: '#f1f8f5', border: '1px solid #008060', borderRadius: '8px',
          padding: '12px', marginBottom: '16px' }}>
          <div style={{ fontSize: '12px', color: '#6d7175', marginBottom: '4px' }}>Last scan</div>
          <div style={{ fontSize: '18px', fontWeight: '700', color: '#008060', wordBreak: 'break-all' }}>
            {result}
          </div>
        </div>
      )}

      {/* 扫描历史 */}
      {lastScans.length > 0 && (
        <div>
          <div style={{ fontSize: '13px', color: '#6d7175', marginBottom: '8px' }}>Scan history</div>
          {lastScans.map((s, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between',
              padding: '8px 0', borderBottom: '1px solid #f1f3f5', fontSize: '14px' }}>
              <span style={{ fontWeight: '500' }}>{s.text}</span>
              <span style={{ color: '#6d7175', fontSize: '12px' }}>{s.time}</span>
            </div>
          ))}
          <button onClick={() => { setLastScans([]); setResult(''); }}
            style={{ marginTop: '8px', padding: '6px 12px', borderRadius: '6px',
              border: '1px solid #c9cccf', background: 'white', cursor: 'pointer',
              fontSize: '13px', color: '#6d7175' }}>
            Clear history
          </button>
        </div>
      )}
    </div>
  );
}

export default CameraTest;