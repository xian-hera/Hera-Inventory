import React, { useState, useEffect, useRef } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';

const SCANNER_ID = 'html5qr-scanner';

const FORMATS = [
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
];

function CameraTest() {
  const [scanning, setScanning]   = useState(false);
  const [result, setResult]       = useState('');
  const [error, setError]         = useState('');
  const [lastScans, setLastScans] = useState([]);
  const scannerRef = useRef(null);
  const cooldown   = useRef(false);

  useEffect(() => {
    return () => { stopCamera(); };
  }, []);

  const startCamera = async () => {
    setError('');
    setResult('');
    try {
      const scanner = new Html5Qrcode(SCANNER_ID, {
        formatsToSupport: FORMATS,
        verbose: false,
      });
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: 280, height: 100 },
          aspectRatio: 1.777,
        },
        (decodedText, decodedResult) => {
          if (cooldown.current) return;
          cooldown.current = true;
          console.log('Scanned:', decodedText, decodedResult);
          setResult(decodedText);
          setLastScans(prev => [
            { text: decodedText, time: new Date().toLocaleTimeString() },
            ...prev.slice(0, 9),
          ]);
          setTimeout(() => { cooldown.current = false; }, 1500);
        },
        () => { /* 未识别到，忽略 */ }
      );
      setScanning(true);
    } catch (e) {
      setError('Camera error: ' + e.message);
    }
  };

  const stopCamera = async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
        scannerRef.current.clear();
      } catch (e) { /* ignore */ }
      scannerRef.current = null;
    }
    setScanning(false);
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

      <div id={SCANNER_ID} style={{ marginBottom: '12px', borderRadius: '12px', overflow: 'hidden' }} />

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

      {result && (
        <div style={{ background: '#f1f8f5', border: '1px solid #008060', borderRadius: '8px',
          padding: '12px', marginBottom: '16px' }}>
          <div style={{ fontSize: '12px', color: '#6d7175', marginBottom: '4px' }}>Last scan</div>
          <div style={{ fontSize: '18px', fontWeight: '700', color: '#008060', wordBreak: 'break-all' }}>
            {result}
          </div>
        </div>
      )}

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