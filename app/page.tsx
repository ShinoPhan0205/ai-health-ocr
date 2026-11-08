"use client";

import React, { useState, useMemo } from "react";
import * as XLSX from "xlsx";
import { Upload, FileDown, CheckCircle, AlertTriangle, ArrowRight, ArrowLeft } from "lucide-react";
import { extractAndFilterPages, ValidPage } from "../lib/pdfProcessor"; 

interface FieldData {
  m1: string;
  m2: string;
  final: string;
  status: "AGREED" | "DISAGREED";
}

interface PatientData {
  _id: number;
  patientImages: ValidPage[]; 
  [key: string]: any; 
}

export default function OCRPage() {
  const [allPdfPages, setAllPdfPages] = useState<ValidPage[]>([]);
  const [reconciledData, setReconciledData] = useState<PatientData[]>([]);
  
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  
  // State điều hướng
  const [patientIndex, setPatientIndex] = useState(0);
  // ĐỔI SANG GLOBAL INDEX: Để khi bấm người khác, ảnh PDF không bị reset
  const [globalImageIndex, setGlobalImageIndex] = useState(0); 
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  // --- CÁC HÀM XỬ LÝ ZOOM & DRAG (KÉO THẢ) ---
  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.5, 5)); // Zoom tối đa 5x
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.5, 0.5)); // Thu nhỏ tối đa 0.5x
  const handleResetZoom = () => { setZoom(1); setPosition({ x: 0, y: 0 }); };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPosition({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  };

  const handleMouseUp = () => setIsDragging(false);

  // Lăn chuột để zoom
  const handleWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) handleZoomIn();
    else handleZoomOut();
  };

  // Reset ảnh về mặc định khi chuyển trang
  const changeGlobalPage = (newIndex: number) => {
    setGlobalImageIndex(newIndex);
    handleResetZoom();
  };
  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setLoading(true);
    setStatus(`Đang bóc tách và nén ảnh từ file ${file.name}...`);
    setAllPdfPages([]);
    setReconciledData([]);
    setPatientIndex(0);
    setGlobalImageIndex(0);

    try {
      const result: ValidPage[][] = await extractAndFilterPages(file);
      const flatPages: ValidPage[] = result.flat();
      
      setAllPdfPages(flatPages);
      setStatus(`✅ Đã xử lý xong. Lọc được ${flatPages.length} trang có dữ liệu.`);
    } catch (error: any) {
      setStatus(`❌ Lỗi đọc PDF: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function fetchWithRetry(modelId: string, pages: ValidPage[], retries = 3): Promise<any> {
    // LỌC BỎ ảnh nét (displayBase64) để tránh quá tải dung lượng truyền lên API
    const aiPayload = pages.map(p => ({
      pageNumber: p.pageNumber,
      base64: p.base64 // Chỉ lấy ảnh mờ
    }));

    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelId, pages: aiPayload }), // Gửi mảng đã lọc
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Lỗi API");
        return data;
      } catch (err: any) {
        if (i === retries - 1) throw err;
        console.warn(`Lần ${i + 1} lỗi với ${modelId}, thử lại...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  async function runDualAI() {
    if (allPdfPages.length === 0) return;
    setLoading(true);
    setReconciledData([]);
    
    try {
      const BATCH_SIZE = 15; // Mỗi lần gửi 15 trang lên Vercel
      let allM1Patients: any[] = [];
      let allM2Patients: any[] = [];
      
      const totalBatches = Math.ceil(allPdfPages.length / BATCH_SIZE);

      // 1. CHẠY VÒNG LẶP CHIA NHỎ VÀ GỬI LÊN API
      for (let i = 0; i < allPdfPages.length; i += BATCH_SIZE) {
        const currentBatch = Math.floor(i / BATCH_SIZE) + 1;
        setStatus(`🧠 Đang gửi AI xử lý đợt ${currentBatch} / ${totalBatches}...`);

        const batchPages = allPdfPages.slice(i, i + BATCH_SIZE);
        
        // Gọi API song song cho đợt hiện tại
        const [res1, res2] = await Promise.all([
          fetchWithRetry("MODEL_1", batchPages, 3),
          fetchWithRetry("MODEL_2", batchPages, 3)
        ]);

        const m1P = res1.patients || [];
        const m2P = res2.patients || [];

        // 2. CHUẨN HÓA INDEX (OFFSET): 
        // Biến số trang của đợt nhỏ (0-14) thành số trang của toàn file (ví dụ đợt hai sẽ là 15-29)
        const adjustedM1 = m1P.map((p: any) => ({
          ...p,
          page_start: typeof p.page_start === "number" ? p.page_start + i : i,
          page_end: typeof p.page_end === "number" ? p.page_end + i : i + batchPages.length - 1
        }));
        
        const adjustedM2 = m2P.map((p: any) => ({
          ...p,
          page_start: typeof p.page_start === "number" ? p.page_start + i : i,
          page_end: typeof p.page_end === "number" ? p.page_end + i : i + batchPages.length - 1
        }));

        // Gộp kết quả của đợt này vào mảng tổng
        allM1Patients = [...allM1Patients, ...adjustedM1];
        allM2Patients = [...allM2Patients, ...adjustedM2];
      }

      setStatus(`🔄 Đang tổng hợp dữ liệu và tìm điểm bất đồng...`);
      
      // 3. ĐỐI CHIẾU VÀ TẠO RA DỮ LIỆU CUỐI CÙNG (RECONCILIATION)
      let allReconciledData: PatientData[] = [];
      const maxLen = Math.max(allM1Patients.length, allM2Patients.length);

      for (let j = 0; j < maxLen; j++) {
        const p1 = allM1Patients[j] || {};
        const p2 = allM2Patients[j] || {};
        
        const startPage = typeof p1.page_start === "number" ? p1.page_start : (typeof p2.page_start === "number" ? p2.page_start : 0);
        const endPage = typeof p1.page_end === "number" ? p1.page_end : (typeof p2.page_end === "number" ? p2.page_end : allPdfPages.length - 1);
        
        // Cắt ảnh dựa trên index toàn cục đã được cộng dồn (Offset)
        const patientImages = allPdfPages.slice(Math.max(0, startPage), Math.min(allPdfPages.length, endPage + 1));

        const patientReconciled: any = { 
          _id: j, 
          patientImages: patientImages 
        }; 

        const allKeys = Array.from(new Set([...Object.keys(p1), ...Object.keys(p2)]));
        allKeys.forEach(key => {
          if (key === "_id" || key === "page_start" || key === "page_end" || key === "SO_TRANG_PDF") return;

          const val1 = String(p1[key] || "").trim();
          const val2 = String(p2[key] || "").trim();
          const isAgreed = val1.toLowerCase() === val2.toLowerCase();
          
          patientReconciled[key] = {
            m1: val1,
            m2: val2,
            final: isAgreed ? val1 : (val1 || val2), 
            status: isAgreed ? "AGREED" : "DISAGREED"
          };
        });
        
        allReconciledData.push(patientReconciled as PatientData);
      }

      setReconciledData(allReconciledData); 
      setPatientIndex(0);
      setGlobalImageIndex(0);
      setStatus(`🎉 Xong! AI đã xử lý thành công ${allReconciledData.length} bệnh nhân.`);
    } catch (error: any) {
      console.error(error);
      setStatus("❌ Lỗi: " + error.message);
    } finally {
      setLoading(false);
    }
  }

  function handleFieldChange(key: string, newValue: string) {
    const updated = [...reconciledData];
    updated[patientIndex][key].final = newValue;
    updated[patientIndex][key].status = "AGREED"; 
    setReconciledData(updated);
  }

  // TÍNH TOÁN SỐ LƯỢNG LỖI CÒN LẠI ĐỂ VALIDATE
  const totalConflicts = useMemo(() => {
    let count = 0;
    reconciledData.forEach(p => {
      Object.keys(p).forEach(k => {
        if (k !== "_id" && k !== "patientImages" && p[k]?.status === "DISAGREED") {
          count++;
        }
      });
    });
    return count;
  }, [reconciledData]);

  function exportToExcel() {
    if (reconciledData.length === 0 || totalConflicts > 0) return;
    const exportArr = reconciledData.map(p => {
      const row: any = {};
      Object.keys(p).forEach(k => {
        if (k !== "_id" && k !== "patientImages") {
          row[k] = p[k]?.final || "";
        }
      });
      return row;
    });

    const ws = XLSX.utils.json_to_sheet(exportArr);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "KhamSucKhoe");
    XLSX.writeFile(wb, "Data_KhamSucKhoe.xlsx");
  }

  const isWorkspaceReady = reconciledData.length > 0;
  const currentPatientData = isWorkspaceReady ? reconciledData[patientIndex] : null;
  // HIỂN THỊ ẢNH TOÀN CỤC THAY VÌ ẢNH TỪNG NGƯỜI
  const currentImageUrl = allPdfPages[globalImageIndex]?.displayBase64 || "";
  const patientName = currentPatientData?.HO_TEN?.final || currentPatientData?.HO_TEN?.m1 || `Bệnh nhân #${patientIndex + 1}`;

  return (
    <div style={{ padding: "20px", fontFamily: "sans-serif", maxWidth: "1600px", margin: "0 auto" }}>
      
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <h2>Hệ Thống Bóc Tách Hồ Sơ Hàng Loạt</h2>
        <div style={{ display: "flex", gap: "10px" }}>
          <label style={{ cursor: "pointer", background: "#3b82f6", color: "white", padding: "10px 20px", borderRadius: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
            <Upload size={18} /> Chọn file PDF
            <input type="file" accept="application/pdf" onChange={handleFileUpload} style={{ display: "none" }} />
          </label>
          
          {allPdfPages.length > 0 && !isWorkspaceReady && (
            <button 
              onClick={runDualAI} 
              disabled={loading} 
              style={{ background: loading ? "#9ca3af" : "#10b981", color: "white", padding: "10px 20px", borderRadius: "8px", fontWeight: "bold", border: "none", cursor: loading ? "not-allowed" : "pointer" }}
            >
              {loading ? "⏳ AI Đang Xử Lý..." : `🚀 Chạy AI Toàn Bộ File (${allPdfPages.length} trang)`}
            </button>
          )}

          {isWorkspaceReady && (
            <button 
              onClick={exportToExcel} 
              disabled={totalConflicts > 0}
              style={{ 
                background: totalConflicts > 0 ? "#d1d5db" : "#f59e0b", 
                color: totalConflicts > 0 ? "#6b7280" : "white", 
                padding: "10px 20px", borderRadius: "8px", border: "none", 
                cursor: totalConflicts > 0 ? "not-allowed" : "pointer", 
                display: "flex", alignItems: "center", gap: "8px", fontWeight: "bold"
              }}
            >
              <FileDown size={18} /> 
              {totalConflicts > 0 ? `Sửa nốt ${totalConflicts} lỗi để Xuất` : "Xuất Excel"}
            </button>
          )}
        </div>
      </div>

      <div style={{ marginBottom: "20px", padding: "10px", background: "#f3f4f6", borderRadius: "8px" }}>
        <strong>Trạng thái: </strong> {status || "Chưa có file nào được tải lên."}
      </div>

      {isWorkspaceReady && currentPatientData && (
        <div style={{ display: "flex", gap: "20px", height: "80vh" }}>
          
          {/* CỘT 1: DANH SÁCH */}
          <div style={{ width: "250px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: "8px", overflowY: "auto" }}>
            <h3 style={{ padding: "15px", margin: 0, borderBottom: "1px solid #e5e7eb", background: "#f9fafb" }}>
              Danh sách ({reconciledData.length})
            </h3>
            {reconciledData.map((p, idx) => {
              const name = p.HO_TEN?.final || p.HO_TEN?.m1 || `Bệnh nhân #${idx + 1}`;
              const hasConflict = Object.keys(p).some(k => k !== "_id" && k !== "patientImages" && p[k]?.status === "DISAGREED");

              return (
                <div 
                  key={idx} 
                  // KHÔNG RESET ẢNH NỮA (Chỉ setPatientIndex)
                  onClick={() => setPatientIndex(idx)}
                  style={{ 
                    padding: "15px", cursor: "pointer", borderBottom: "1px solid #f3f4f6",
                    background: patientIndex === idx ? "#eff6ff" : "transparent",
                    borderLeft: patientIndex === idx ? "4px solid #3b82f6" : "4px solid transparent",
                    display: "flex", alignItems: "center", justifyContent: "space-between"
                  }}
                >
                  <span style={{ fontWeight: patientIndex === idx ? "bold" : "normal", fontSize: "14px" }}>{name}</span>
                  {hasConflict ? <AlertTriangle size={16} color="#ef4444" /> : <CheckCircle size={16} color="#10b981" />}
                </div>
              );
            })}
          </div>

          {/* CỘT 2: TRÌNH XEM ẢNH TOÀN CỤC (Có Zoom & Drag) */}
          <div style={{ flex: 1, background: "#f9fafb", borderRadius: "8px", border: "1px solid #e5e7eb", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            
            {/* Thanh công cụ điều hướng & Zoom */}
            <div style={{ padding: "10px", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fff", borderBottom: "1px solid #e5e7eb" }}>
              <div>
                <button 
                  onClick={() => changeGlobalPage(Math.max(0, globalImageIndex - 1))}
                  disabled={globalImageIndex === 0}
                  style={{ padding: "8px 12px", cursor: globalImageIndex === 0 ? "not-allowed" : "pointer" }}
                >
                  <ArrowLeft size={16} />
                </button>
                <strong style={{ margin: "0 15px" }}>Trang {globalImageIndex + 1} / {allPdfPages.length}</strong>
                <button 
                  onClick={() => changeGlobalPage(Math.min(allPdfPages.length - 1, globalImageIndex + 1))}
                  disabled={globalImageIndex === allPdfPages.length - 1}
                  style={{ padding: "8px 12px", cursor: globalImageIndex === allPdfPages.length - 1 ? "not-allowed" : "pointer" }}
                >
                  <ArrowRight size={16} />
                </button>
              </div>

              {/* Nhóm nút Zoom */}
              <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
                <button onClick={handleZoomOut} style={{ padding: "6px 12px", cursor: "pointer", borderRadius: "6px", border: "1px solid #d1d5db" }}>➖</button>
                <button onClick={handleResetZoom} style={{ padding: "6px 12px", cursor: "pointer", borderRadius: "6px", border: "1px solid #d1d5db", minWidth: "60px" }}>
                  {Math.round(zoom * 100)}%
                </button>
                <button onClick={handleZoomIn} style={{ padding: "6px 12px", cursor: "pointer", borderRadius: "6px", border: "1px solid #d1d5db" }}>➕</button>
              </div>
            </div>
            
            {/* Khung tương tác kéo thả */}
            <div 
              style={{ 
                flex: 1, 
                position: "relative",
                overflow: "hidden", 
                cursor: isDragging ? "grabbing" : "grab", // Hiển thị icon bàn tay nắm lại khi kéo
                background: "#e5e7eb"
              }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onWheel={handleWheel}
            >
               {currentImageUrl ? (
                 <img 
                   src={currentImageUrl} 
                   alt="PDF Page" 
                   draggable={false} // Chặn trình duyệt kéo ảnh dạng file
                   style={{ 
                     position: "absolute",
                     transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`,
                     transformOrigin: "center center",
                     transition: isDragging ? "none" : "transform 0.1s ease-out", // Mượt khi bấm nút, tức thời khi kéo chuột
                     maxWidth: "100%", 
                     height: "auto",
                     left: 0, right: 0, top: 0, bottom: 0, margin: "auto", // Ép ảnh vào giữa màn hình
                     pointerEvents: "none" // Chuyển sự kiện chuột cho thẻ Div cha xử lý
                   }} 
                 />
               ) : (
                 <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%", color: "gray" }}>Không tìm thấy ảnh</div>
               )}
            </div>
          </div>

          {/* CỘT 3: FORM CHỈNH SỬA THÔNG MINH */}
          <div style={{ width: "450px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: "8px", display: "flex", flexDirection: "column" }}>
             <h3 style={{ padding: "15px", margin: 0, borderBottom: "1px solid #e5e7eb", background: "#f9fafb", color: "#1f2937" }}>
               Chi tiết: {patientName}
             </h3>
             <div style={{ flex: 1, overflowY: "auto", padding: "15px", display: "flex", flexDirection: "column", gap: "15px" }}>
               {Object.keys(currentPatientData).map(key => {
                 if (key === "_id" || key === "patientImages") return null;
                 const field = currentPatientData[key];
                 const isAgreed = field.status === "AGREED";

                 return (
                   <div key={key} style={{ 
                     background: isAgreed ? "transparent" : "#fef2f2", 
                     padding: isAgreed ? "0" : "12px", 
                     borderRadius: "8px",
                     border: isAgreed ? "none" : "1px solid #fca5a5"
                   }}>
                     <label style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", fontWeight: "bold", color: "#4b5563", marginBottom: "8px" }}>
                       {key}
                       {!isAgreed && <span style={{ color: "#ef4444", fontSize: "11px", fontWeight: "bold" }}>Bất đồng</span>}
                     </label>
                     
                     {/* CÁC NÚT CHỌN NHANH KHI BẤT ĐỒNG */}
                     {!isAgreed && (
                       <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
                         <button 
                            onClick={() => handleFieldChange(key, field.m1)}
                            style={{ flex: 1, padding: "8px", fontSize: "12px", background: "#dbeafe", color: "#1e3a8a", border: "1px solid #bfdbfe", borderRadius: "6px", cursor: "pointer", textAlign: "left" }}
                         >
                           <strong>M1:</strong> {field.m1 || "(Trống)"}
                         </button>
                         <button 
                            onClick={() => handleFieldChange(key, field.m2)}
                            style={{ flex: 1, padding: "8px", fontSize: "12px", background: "#e0e7ff", color: "#3730a3", border: "1px solid #c7d2fe", borderRadius: "6px", cursor: "pointer", textAlign: "left" }}
                         >
                           <strong>M2:</strong> {field.m2 || "(Trống)"}
                         </button>
                       </div>
                     )}

                     <textarea
                        value={field.final}
                        onChange={(e) => handleFieldChange(key, e.target.value)}
                        placeholder="Hoặc tự nhập vào đây..."
                        style={{
                          width: "100%", padding: "10px", 
                          border: `1px solid ${isAgreed ? "#d1d5db" : "#f87171"}`, 
                          borderRadius: "6px", minHeight: "40px", fontSize: "14px", resize: "vertical"
                        }}
                     />
                   </div>
                 );
               })}
             </div>
          </div>

        </div>
      )}
    </div>
  );
}