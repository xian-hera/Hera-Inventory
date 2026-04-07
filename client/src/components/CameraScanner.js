import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';

const FORMATS = [
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
];

// 唯一 DOM id，避免多个实例冲突
let instanceCount = 0;

/**
 * CameraScanner
 * Props:
 *   onScan(barcode: string) — 扫描成功回调，每次识别到条码调用一次
 *   onClose()              — 用户点关闭按钮时调用
 *   pauseRef               — 外部传入的 ref，.current = true 时暂停识别（弹窗期间）
 */
function CameraScanner({ onScan, onClose, pauseRef }) {
  const [scannerReady, setScannerReady] = useState(false);
  const [initError, setInitError]       = useState('');
  const scannerRef  = useRef(null);
  const cooldown    = useRef(false);
  const idRef       = useRef(`cs_${++instanceCount}`);

  useEffect(() => {
    const id = idRef.current;
    let scanner;

    const start = async () => {
      try {
        scanner = new Html5Qrcode(id, { formatsToSupport: FORMATS, verbose: false });
        scannerRef.current = scanner;

        await scanner.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: { width: 260, height: 90 },
            aspectRatio: 1.777,
          },
          (decodedText) => {
            if (pauseRef && pauseRef.current) return;
            if (cooldown.current) return;
            cooldown.current = true;
            onScan(decodedText);
            setTimeout(() => { cooldown.current = false; }, 1500);
          },
          () => {}
        );
        setScannerReady(true);
      } catch (e) {
        // 如果后置摄像头失败，尝试不指定 facingMode
        try {
          await scanner.start(
            { facingMode: 'user' },
            { fps: 10, qrbox: { width: 260, height: 90 }, aspectRatio: 1.777 },
            (decodedText) => {
              if (pauseRef && pauseRef.current) return;
              if (cooldown.current) return;
              cooldown.current = true;
              onScan(decodedText);
              setTimeout(() => { cooldown.current = false; }, 1500);
            },
            () => {}
          );
          setScannerReady(true);
        } catch (e2) {
          setInitError('Could not start camera: ' + (e2?.message || e?.message || 'Permission denied'));
        }
      }
    };

    start();

    return () => {
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {}).finally(() => {
          scannerRef.current?.clear();
          scannerRef.current = null;
        });
      }
    };
  }, []);

  const handleClose = () => {
    if (scannerRef.current) {
      scannerRef.current.stop().catch(() => {}).finally(() => {
        scannerRef.current?.clear();
        scannerRef.current = null;
        onClose();
      });
    } else {
      onClose();
    }
  };

  return (
    // 底部固定弹出，高度约 1/3 屏幕
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0,
      background: 'rgba(0,0,0,0.92)',
      borderRadius: '16px 16px 0 0',
      zIndex: 3000,
      paddingBottom: 'env(safe-area-inset-bottom)',
    }}>
      {/* 顶部栏：标题 + 关闭 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px 8px',
      }}>
        <span style={{ color: 'white', fontSize: '14px', fontWeight: '600' }}>
          📷 Scanning...
        </span>
        <button
          onClick={handleClose}
          style={{
            background: 'rgba(255,255,255,0.15)', border: 'none',
            borderRadius: '50%', width: '32px', height: '32px',
            color: 'white', fontSize: '18px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          ✕
        </button>
      </div>

      {/* 错误提示 */}
      {initError && (
        <div style={{ color: '#ff6b6b', fontSize: '13px', textAlign: 'center', padding: '8px 16px' }}>
          {initError}
        </div>
      )}

      {/* 取景区域 */}
      <div style={{ padding: '0 16px 16px' }}>
        <div
          id={idRef.current}
          style={{ borderRadius: '10px', overflow: 'hidden', width: '100%' }}
        />
      </div>

      {/* 提示文字 */}
      {scannerReady && (
        <div style={{
          textAlign: 'center', color: 'rgba(255,255,255,0.5)',
          fontSize: '12px', paddingBottom: '12px',
        }}>
          Align barcode within the frame
        </div>
      )}
    </div>
  );
}

export default CameraScanner;