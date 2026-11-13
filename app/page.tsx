"use client";

import React, { useState, useMemo, useEffect, useRef } from "react";
import * as XLSX from "xlsx";
import { Upload, FileDown, CheckCircle, AlertTriangle, ArrowRight, ArrowLeft, Trash2, X } from "lucide-react";
import { extractAndFilterPages, ValidPage } from "../lib/pdfProcessor";
import { set, get, del } from 'idb-keyval';

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

// Các trường E:X trong biểu mẫu là thông tin hành chính; giữ nội bộ để nhận diện
// và đối chiếu bệnh nhân nhưng không hiển thị trong phần khám và không xuất Excel.
const ADMINISTRATIVE_FIELDS = new Set([
  "HO_TEN", "GIOI_TINH", "NGAY_SINH", "MA_DAN_TOC", "SO_CCCD", "NGAYCAP_CCCD",
  "NOICAP_CCCD", "MATINH_CU_TRU", "MAXA_CU_TRU", "DIA_CHI", "MA_NGHE_NGHIEP",
  "NHOM_MAU", "DOI_TUONG", "NGUON_CHI_TRA", "NOI_LAM_VIEC_HOC_TAP", "DIEN_THOAI",
  "LY_DO_VV", "MA_LOAI_KCB"
]);

// Thứ tự các trường lâm sàng lấy theo đúng các cột Y:CY của file Excel mẫu.
const ADULT_CLINICAL_FIELD_ORDER = [
  "TSGD_MAC_BENH", "TSGD_MA_BENH",
  "TSBT_BENH_TRONG_5_NAM_QUA", "TSBT_BENH_THAN_KINH", "TSBT_BENH_MAT", "TSBT_BENH_TAI",
  "TSBT_BENH_TIM", "TSBT_PHAU_THUAT_TIM", "TSBT_TANG_HUYET_AP", "TSBT_KHO_THO",
  "TSBT_BENH_PHOI", "TSBT_BENH_THAN", "TSBT_NGHIEN_RUOU", "TSBT_DAI_THAO_DUONG",
  "TSBT_BENH_TAM_THAN", "TSBT_MAT_Y_THUC", "TSBT_NGAT", "TSBT_BENH_TIEU_HOA",
  "TSBT_ROI_LOAN_GIAC_NGU", "TSBT_TAI_BIEN", "TSBT_BENH_COT_SONG", "TSBT_RUOU_THUONG_XUYEN",
  "TSBT_MA_TUY", "TSBT_BENH_KHAC", "TSBT_MA_BENH_KHAC", "TSBT_DANG_DIEU_TRI_BENH",
  "TSBT_MA_BENH", "TSBT_TEN_THUOC_LIEU_LUONG", "TSBT_THAI_SAN", "TSBT_MA_BENH_THAI_SAN",
  "TSBT_TEN_THUOC_THAI_SAN", "CHIEU_CAO", "CAN_NANG", "CHI_SO_BMI", "MACH", "HUYET_AP",
  "KHAM_THE_LUC_PL", "NOI_KHOA_TUAN_HOAN", "NOI_KHOA_TUAN_HOAN_PL", "NOI_KHOA_HO_HAP",
  "NOI_KHOA_HO_HAP_PL", "NOI_KHOA_TIEU_HOA", "NOI_KHOA_TIEU_HOA_PL", "NOI_KHOA_THAN_TN_SD",
  "NOI_KHOA_THAN_TIETNIEU_PL", "NOI_KHOA_NOI_TIET", "NOI_KHOA_NOI_TIET_PL",
  "NOI_KHOA_CO_XUONG_KHOP", "NOI_KHOA_CO_XUONG_KHOP_PL", "NOI_KHOA_THAN_KINH",
  "NOI_KHOA_THAN_KINH_PL", "NOI_KHOA_TAM_THAN", "NOI_KHOA_TAM_THAN_PL", "KET_QUA_KHAM_NGOAI_KHOA",
  "KHAM_NGOAI_KHOA_PL", "KET_QUA_KHAM_DA_LIEU", "KHAM_DA_LIEU_PL", "KET_QUA_KHAM_SAN_PHU_KHOA",
  "KHAM_SAN_PHU_KHOA_PL", "KHONG_KINH_MAT_PHAI", "KHONG_KINH_MAT_TRAI", "CO_KINH_MAT_PHAI",
  "CO_KINH_MAT_TRAI", "BENH_KHAC_MAT", "KHAM_MAT_PL", "TAI_TRAI_NOI_THUONG", "TAI_TRAI_NOI_THAM",
  "TAI_PHAI_NOI_THUONG", "TAI_PHAI_NOI_THAM", "BENH_KHAC_TAI_MUI_HONG", "KHAM_TAI_MUI_HONG_PL",
  "HAM_TREN", "HAM_DUOI", "BENH_KHAC_RANG_HAM_MAT", "KHAM_RANG_HAM_MAT_PL", "PHAN_LOAI_SK",
  "KET_LUAN_BENH", "CAC_BENH_TAT_NEU_CO"
];
const ADULT_CLINICAL_FIELD_SET = new Set(ADULT_CLINICAL_FIELD_ORDER);

export default function OCRPage() {
  const [allPdfPages, setAllPdfPages] = useState<ValidPage[]>([]);
  const [reconciledData, setReconciledData] = useState<PatientData[]>([]);
  const [docType, setDocType] = useState("ADULT_18");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  // Theo dõi khi người dùng chuyển sang tab khác để hiển thị trạng thái chạy nền.
  const [isTabHidden, setIsTabHidden] = useState(false);
  const originalDocumentTitleRef = useRef<string | null>(null);

  // Tác vụ upload PDF và Dual AI vẫn chạy trong vòng đời của tab này khi tab bị ẩn.
  // Đổi tiêu đề tab để người dùng nhận biết ứng dụng đang tiếp tục xử lý ở nền.
  useEffect(() => {
    if (originalDocumentTitleRef.current === null) {
      originalDocumentTitleRef.current = document.title;
    }

    const syncBackgroundState = () => {
      const hidden = document.visibilityState === "hidden";
      setIsTabHidden(hidden);
      if (loading) {
        document.title = hidden
          ? "⏳ Đang chạy nền | Hệ thống KSK"
          : "⏳ Đang xử lý | Hệ thống KSK";
      } else {
        document.title = originalDocumentTitleRef.current || "Hệ thống KSK";
      }
    };

    syncBackgroundState();
    document.addEventListener("visibilitychange", syncBackgroundState);
    return () => document.removeEventListener("visibilitychange", syncBackgroundState);
  }, [loading]);

  // Khôi phục tiêu đề ban đầu khi rời trang.
  useEffect(() => {
    return () => {
      if (originalDocumentTitleRef.current !== null) {
        document.title = originalDocumentTitleRef.current;
      }
    };
  }, []);

  // State điều hướng
  const [patientIndex, setPatientIndex] = useState(0);
  const [globalImageIndex, setGlobalImageIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Ref dùng để cuộn trang UI form
  const formScrollRef = useRef<HTMLDivElement>(null);

  // --- CÁC HÀM XỬ LÝ ZOOM & DRAG (KÉO THẢ) ---
  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.5, 5));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.5, 0.5));
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

  const handleWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) handleZoomIn();
    else handleZoomOut();
  };

  const changeGlobalPage = (newIndex: number) => {
    setGlobalImageIndex(newIndex);
    handleResetZoom();
  };

  // --- TỰ ĐỘNG CUỘN LÊN ĐẦU KHI CHUYỂN BỆNH NHÂN ---
  useEffect(() => {
    if (formScrollRef.current) {
      formScrollRef.current.scrollTop = 0;
    }
  }, [patientIndex]);

  // --- 1. KHÔI PHỤC PHIÊN LÀM VIỆC KHI F5 HOẶC MỞ LẠI TRANG ---
  useEffect(() => {
    const loadSession = async () => {
      try {
        const savedPages = await get('saved_pdf_pages');
        if (savedPages && savedPages.length > 0) {
          setAllPdfPages(savedPages);
        }

        const savedData = await get('saved_reconciled_data');
        if (savedData && savedData.length > 0) {
          setReconciledData(savedData);
        }
      } catch (error) {
        console.error("Lỗi khi khôi phục phiên làm việc:", error);
      } finally {
        setSessionLoaded(true);
      }
    };
    loadSession();
  }, []);

  // --- 2. TỰ ĐỘNG LƯU KẾT QUẢ AI MỖI KHI BẠN CHỈNH SỬA ---
  useEffect(() => {
    if (!sessionLoaded) return;
    // Lưu cả mảng rỗng để xóa hết bệnh nhân không làm dữ liệu cũ xuất hiện lại sau F5.
    set('saved_reconciled_data', reconciledData).catch(console.error);
  }, [reconciledData, sessionLoaded]);

  // --- 3. HÀM TẢI FILE PDF LÊN ---
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
      // Xóa sạch bộ nhớ cũ khi tải file mới lên
      await del('saved_pdf_pages');
      await del('saved_reconciled_data');

      const result: ValidPage[][] = await extractAndFilterPages(file, (processed, total) => {
        setStatus(`Đang bóc tách và nén ảnh: ${processed}/${total} trang PDF...`);
      });
      const flatPages: ValidPage[] = result.flat();

      setAllPdfPages(flatPages);

      // Phân biệt thời gian bóc tách với thời gian lưu cache để dễ nhận ra nút thắt.
      setStatus(`Đã bóc tách ${flatPages.length} trang có dữ liệu. Đang lưu phiên làm việc...`);
      await set('saved_pdf_pages', flatPages);

      setStatus(`✅ Đã xử lý xong. Lọc được ${flatPages.length} trang có dữ liệu.`);
    } catch (error: any) {
      setStatus(`❌ Lỗi đọc PDF: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  // --- 4. HÀM GỌI API ---
  async function fetchWithRetry(
    modelId: string,
    pages: ValidPage[],
    retries = 3,
    patientRanges?: Array<{ segment_index: number; page_start: number; page_end: number }>
  ): Promise<any> {
    const aiPayload = pages.map(p => ({ pageNumber: p.pageNumber, base64: p.base64 }));

    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelId, pages: aiPayload, docType, patientRanges }),
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
    throw new Error(`Không gọi được ${modelId} sau ${retries} lần thử.`);
  }

  // --- 5. HÀM XỬ LÝ AI ---
  async function runDualAI() {
    if (allPdfPages.length === 0 || loading) return;
    setLoading(true);
    setReconciledData([]);
    setPatientIndex(0);
    setGlobalImageIndex(0);

    try {
      const BATCH_SIZE = 15;
      const allM1Patients: any[] = [];
      const allM2Patients: any[] = [];
      let adultRanges: Array<{ id: number; start: number; end: number }> = [];
      let skippedIncompleteNotice = "";

      if (docType === "ADULT_18") {
        // Ranh giới bệnh nhân do OCR vùng đầu trang xác định, Gemini không tự chia nhóm.
        const starts = allPdfPages
          .map((page, index) => page.documentMarker === "PATIENT_START" ? index : -1)
          .filter(index => index >= 0);
        const labs = allPdfPages
          .map((page, index) => page.documentMarker === "LAB_START" ? index : -1)
          .filter(index => index >= 0);

        if (starts.length === 0) {
          throw new Error("OCR chưa nhận diện được tiêu đề giấy khám sức khỏe người từ đủ 18 tuổi. Vui lòng kiểm tra vùng đầu trang hoặc tải lại PDF.");
        }

        // Nếu PDF được cắt từ giữa một tập hồ sơ, bỏ qua phần đầu cho đến
        // PATIENT_START đầu tiên. Không cố đoán hoặc ghép phần đầu đó vào bệnh nhân mới.
        const leadingPagesNotice = starts[0] > 0
          ? ` Đã tự động bỏ qua các trang đầu file trước trang PDF ${allPdfPages[starts[0]].pageNumber} vì chưa có dấu bắt đầu hồ sơ.`
          : "";

        // Không để một hồ sơ bị cắt dở (thường là hồ sơ cuối file do người dùng
        // chia PDF) chặn các hồ sơ hoàn chỉnh đứng trước. Giữ nguyên id gốc của
        // starts để segment_index M1/M2 vẫn khớp sau khi lọc hồ sơ thiếu.
        const skippedIncompleteRanges: Array<{ id: number; start: number }> = [];
        const detectedRanges = starts.map((start, id) => {
          const nextStart = starts[id + 1] ?? allPdfPages.length;
          const labIndex = labs.find(index => index >= start && index < nextStart);
          if (labIndex === undefined) {
            skippedIncompleteRanges.push({ id, start });
            return null;
          }

          // Tiêu đề phiếu xét nghiệm là dấu kết thúc hồ sơ khám.
          // Không đưa trang xét nghiệm này hoặc các trang lưu trữ tiếp theo vào Gemini/Excel.
          const end = labIndex - 1;
          if (end < start) {
            skippedIncompleteRanges.push({ id, start });
            return null;
          }
          return { id, start, end };
        });
        adultRanges = detectedRanges.filter(
          (range): range is { id: number; start: number; end: number } => range !== null
        );

        const skippedStartPages = skippedIncompleteRanges.map(
          item => allPdfPages[item.start].pageNumber
        );
        skippedIncompleteNotice = skippedStartPages.length > 0
          ? ` Đã bỏ qua ${skippedStartPages.length} hồ sơ chưa đủ thành phần bắt buộc (bắt đầu tại trang PDF ${skippedStartPages.slice(0, 10).join(", ")}${skippedStartPages.length > 10 ? ` và ${skippedStartPages.length - 10} hồ sơ khác` : ""}); các hồ sơ này không được gửi AI.`
          : "";

        // Nếu không còn hồ sơ hợp lệ thì dừng trước khi gọi API, nhưng không
        // biến hồ sơ thiếu thành lỗi làm mất các kết quả hợp lệ (vì lúc này không có hồ sơ hợp lệ).
        if (adultRanges.length === 0) {
          throw new Error(
            `Không có hồ sơ nào đủ thành phần bắt buộc để gửi AI.${skippedIncompleteNotice || " Vui lòng kiểm tra PDF và dấu mốc OCR."}`
          );
        }

        // Các trang từ tiêu đề PHIẾU KẾT QUẢ XÉT NGHIỆM trở đi là tài liệu lưu trữ.
        // Chúng vẫn nằm trong allPdfPages để xem ảnh gốc, nhưng không thuộc dữ liệu khám gửi AI.

        // Chỉ tính các trang khám; trang phiếu xét nghiệm và phần tiếp theo không nằm trong phạm vi trích xuất.
        // Một hồ sơ khám tối đa 15 trang/request. Nếu hồ sơ đơn lẻ dài hơn, dừng an toàn thay vì cắt đôi.
        for (const range of adultRanges) {
          if (range.end - range.start + 1 > BATCH_SIZE) {
            throw new Error(`Hồ sơ bắt đầu ở trang PDF ${allPdfPages[range.start].pageNumber} dài hơn 15 trang. Phiên bản này chưa chia một hồ sơ dài thành nhiều request; chưa gửi AI để tránh mất ngữ cảnh.`);
          }
        }

        // Gom nhiều hồ sơ theo thứ tự vào cùng request nhưng tuyệt đối không cắt giữa hồ sơ.
        // Các trang phiếu xét nghiệm nằm giữa các hồ sơ sẽ được bỏ qua khỏi request.
        let cursor = 0;
        let batchNumber = 0;
        while (cursor < adultRanges.length) {
          let lastRangeIndex = cursor;
          let pageCount = 0;
          while (lastRangeIndex < adultRanges.length) {
            const candidate = adultRanges[lastRangeIndex];
            const candidateLength = candidate.end - candidate.start + 1;
            if (pageCount + candidateLength > BATCH_SIZE) break;
            pageCount += candidateLength;
            lastRangeIndex++;
          }

          const batchRanges = adultRanges.slice(cursor, lastRangeIndex);

          // Nén các trang khám của từng bệnh nhân thành một request liên tục.
          // Khoảng trống giữa các bệnh nhân chính là trang xét nghiệm lưu trữ,
          // vì vậy tuyệt đối không đưa các trang đó vào batchPages.
          const batchPages: ValidPage[] = [];
          const requestRanges = batchRanges.map(range => {
            const patientPages = allPdfPages.slice(range.start, range.end + 1);
            const localStart = batchPages.length;
            batchPages.push(...patientPages);
            return {
              segment_index: range.id,
              page_start: localStart,
              page_end: localStart + patientPages.length - 1
            };
          });

          if (batchPages.length === 0 || batchPages.length > BATCH_SIZE) {
            throw new Error("Lô gửi AI không hợp lệ sau khi loại các trang phiếu xét nghiệm lưu trữ.");
          }

          batchNumber++;
          setStatus(`🧠 OCR đã chia ranh giới. Đang gửi đợt ${batchNumber} — ${batchRanges.length} hồ sơ, ${batchPages.length}/15 trang khám cho M1 và M2 (không gửi phiếu xét nghiệm)...${batchNumber === 1 ? leadingPagesNotice + skippedIncompleteNotice : ""}`);

          const [res1, res2] = await Promise.all([
            fetchWithRetry("MODEL_1", batchPages, 3, requestRanges),
            fetchWithRetry("MODEL_2", batchPages, 3, requestRanges)
          ]);

          const attachAuthoritativeRanges = (patients: any[], model: string) => {
            const mapped = new Map<number, any>();
            (Array.isArray(patients) ? patients : []).forEach(patient => {
              const segmentId = Number(patient.segment_index);
              const range = adultRanges.find(item => item.id === segmentId);
              if (!range || mapped.has(segmentId)) return;
              mapped.set(segmentId, {
                ...patient,
                page_start: range.start,
                page_end: range.end,
                _sourceModel: model,
                _segmentIndex: segmentId
              });
            });
            return mapped;
          };

          const mappedM1 = attachAuthoritativeRanges(res1.patients, "M1");
          const mappedM2 = attachAuthoritativeRanges(res2.patients, "M2");
          for (const range of batchRanges) {
            const p1 = mappedM1.get(range.id);
            const p2 = mappedM2.get(range.id);
            if (p1) allM1Patients.push(p1);
            if (p2) allM2Patients.push(p2);
          }
          cursor = lastRangeIndex;
        }
      } else {
        // Giữ nguyên luồng chia lô AI cũ cho loại hồ sơ học sinh.
        const totalBatches = Math.ceil(allPdfPages.length / BATCH_SIZE);
        const toValidPage = (value: any, fallback: number) => {
          const n = Number(value);
          return Number.isInteger(n) && n >= 0 ? n : fallback;
        };
        for (let offset = 0; offset < allPdfPages.length; offset += BATCH_SIZE) {
          const currentBatch = Math.floor(offset / BATCH_SIZE) + 1;
          setStatus(`🧠 Đang gửi AI xử lý đợt ${currentBatch}/${totalBatches}...`);
          const batchPages = allPdfPages.slice(offset, offset + BATCH_SIZE);
          const [res1, res2] = await Promise.all([
            fetchWithRetry("MODEL_1", batchPages, 3),
            fetchWithRetry("MODEL_2", batchPages, 3)
          ]);
          const adjustRanges = (patients: any[], model: string) => (Array.isArray(patients) ? patients : [])
            .map((p: any) => {
              const localStart = toValidPage(p.page_start, -1);
              const localEnd = toValidPage(p.page_end, -1);
              if (localStart < 0 || localEnd < localStart || localStart >= batchPages.length) return null;
              return { ...p, page_start: localStart + offset, page_end: Math.min(localEnd, batchPages.length - 1) + offset, _sourceModel: model };
            })
            .filter(Boolean);
          allM1Patients.push(...adjustRanges(res1.patients, "M1"));
          allM2Patients.push(...adjustRanges(res2.patients, "M2"));
        }
      }

      setStatus("🔄 Đang đối chiếu độc lập kết quả M1 và M2...");

      const normalize = (value: any) => String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLocaleUpperCase("vi-VN");
      const getName = (p: any) => normalize(p.HO_TEN || p.ho_ten || p.Ho_Ten || p.fullName);
      const getDob = (p: any) => normalize(p.NGAY_SINH || p.dateOfBirth || p.ngay_sinh);
      const getId = (p: any) => normalize(p.SO_CCCD || p.idNumber || p.cccd || p.SO_CMND);
      const hasStrongIdentity = (a: any, b: any) => {
        const aId = getId(a), bId = getId(b);
        if (aId && bId && aId === bId) return true;
        const aName = getName(a), bName = getName(b);
        const aDob = getDob(a), bDob = getDob(b);
        return !!aName && !!bName && aName === bName && !!aDob && !!bDob && aDob === bDob;
      };

      let groups: Array<{ a: any; b: any; start: number; end: number; warning?: string }> = [];

      if (docType === "ADULT_18") {
        // Ghép theo segment_index do OCR xác định, không dùng tên bệnh nhân làm khóa.
        const m1BySegment = new Map<number, any>(allM1Patients.map(p => [p._segmentIndex, p]));
        const m2BySegment = new Map<number, any>(allM2Patients.map(p => [p._segmentIndex, p]));
        groups = adultRanges.map(range => {
          const a = m1BySegment.get(range.id) || null;
          const b = m2BySegment.get(range.id) || null;
          return {
            a, b, start: range.start, end: range.end,
            warning: !a || !b ? "Một trong hai mô hình không trả về hồ sơ này. Cần kiểm tra kết quả và ảnh gốc." : ""
          };
        });
      } else {
        // Logic ghép cũ cho hồ sơ học sinh: ghép cùng mô hình theo định danh mạnh, rồi đối chiếu M1/M2 theo vùng trang.
        const mergeAdjacentByIdentity = (records: any[]) => {
          const sorted = [...records].sort((a, b) => a.page_start - b.page_start);
          const merged: any[] = [];
          for (const record of sorted) {
            const previous = merged[merged.length - 1];
            if (previous && record.page_start <= previous.page_end + 2 && hasStrongIdentity(previous, record)) {
              previous.page_end = Math.max(previous.page_end, record.page_end);
              Object.keys(record).forEach(key => { if (!previous[key] && record[key]) previous[key] = record[key]; });
            } else merged.push({ ...record });
          }
          return merged;
        };
        const m1 = mergeAdjacentByIdentity(allM1Patients);
        const m2 = mergeAdjacentByIdentity(allM2Patients);
        const candidatePairs: Array<{ i: number; j: number; overlap: number }> = [];
        m1.forEach((a, i) => m2.forEach((b, j) => {
          const overlap = Math.max(0, Math.min(a.page_end, b.page_end) - Math.max(a.page_start, b.page_start) + 1);
          if (overlap > 0) candidatePairs.push({ i, j, overlap });
        }));
        candidatePairs.sort((a, b) => b.overlap - a.overlap);
        const pairedM1 = new Set<number>();
        const pairedM2 = new Set<number>();
        for (const pair of candidatePairs) {
          if (pairedM1.has(pair.i) || pairedM2.has(pair.j)) continue;
          const a = m1[pair.i], b = m2[pair.j];
          const idA = getId(a), idB = getId(b), nameA = getName(a), nameB = getName(b), dobA = getDob(a), dobB = getDob(b);
          const sameId = !!idA && !!idB && idA === idB;
          const identityConflict = (!!idA && !!idB && idA !== idB) ||
            (!sameId && !!nameA && !!nameB && nameA !== nameB) ||
            (!sameId && !!nameA && !!nameB && nameA === nameB && !!dobA && !!dobB && dobA !== dobB);
          if (identityConflict) continue;
          pairedM1.add(pair.i); pairedM2.add(pair.j);
          groups.push({ a, b, start: Math.min(a.page_start, b.page_start), end: Math.max(a.page_end, b.page_end) });
        }
        m1.forEach((a, i) => { if (!pairedM1.has(i)) groups.push({ a, b: null, start: a.page_start, end: a.page_end, warning: "Chỉ có kết quả từ M1 hoặc chưa tìm được bản ghi đối chiếu; cần kiểm tra ảnh." }); });
        m2.forEach((b, j) => { if (!pairedM2.has(j)) groups.push({ a: null, b, start: b.page_start, end: b.page_end, warning: "Chỉ có kết quả từ M2 hoặc chưa tìm được bản ghi đối chiếu; cần kiểm tra ảnh." }); });
        groups.sort((a, b) => a.start - b.start);
      }

      const allReconciledData: PatientData[] = groups.map((group, index) => {
        // Không sao chép kết quả một model sang cột model còn thiếu; phải thể hiện đúng model nào chưa trả kết quả.
        const p1 = group.a || {};
        const p2 = group.b || {};
        const startPage = Math.max(0, Math.min(group.start, allPdfPages.length - 1));
        const endPage = Math.max(startPage, Math.min(group.end, allPdfPages.length - 1));
        const patientImages = allPdfPages.slice(startPage, endPage + 1);
        const patientReconciled: any = { _id: index, patientImages, _groupingWarning: group.warning || "" };

        let allKeys = Array.from(new Set([...Object.keys(p1), ...Object.keys(p2)]));
        allKeys = allKeys.filter(key => !["_id", "page_start", "page_end", "segment_index", "SO_TRANG_PDF", "_sourceModel", "_segmentIndex"].includes(key));
        if (docType === "ADULT_18") {
          // Luôn tạo đủ các trường lâm sàng của mẫu, kể cả khi cả hai model không trả về giá trị;
          // các ô thiếu dữ liệu sẽ để trống chứ không tự bịa nội dung.
          allKeys = Array.from(new Set([...ADULT_CLINICAL_FIELD_ORDER, ...allKeys]));
          const fieldOrder = new Map(ADULT_CLINICAL_FIELD_ORDER.map((key, index) => [key, index]));
          allKeys.sort((a, b) => (fieldOrder.get(a) ?? 10000) - (fieldOrder.get(b) ?? 10000));
        }
        if (!allKeys.includes("KET_QUA_KHAM_SAN_PHU_KHOA")) allKeys.push("KET_QUA_KHAM_SAN_PHU_KHOA");
        if (!allKeys.includes("KHAM_SAN_PHU_KHOA_PL")) allKeys.push("KHAM_SAN_PHU_KHOA_PL");
        allKeys = allKeys.filter(k => k !== "KET_QUA_KHAM_SAN_PHU_KHOA" && k !== "KHAM_SAN_PHU_KHOA_PL");
        let insertIndex = allKeys.indexOf("KHAM_DA_LIEU_PL");
        if (insertIndex === -1) insertIndex = allKeys.indexOf("DA_LIEU_PL");
        if (insertIndex === -1) insertIndex = allKeys.indexOf("DA_LIEU");
        if (insertIndex !== -1) allKeys.splice(insertIndex + 1, 0, "KET_QUA_KHAM_SAN_PHU_KHOA", "KHAM_SAN_PHU_KHOA_PL");
        else {
          const matIndex = allKeys.indexOf("MAT");
          if (matIndex !== -1) allKeys.splice(matIndex, 0, "KET_QUA_KHAM_SAN_PHU_KHOA", "KHAM_SAN_PHU_KHOA_PL");
          else allKeys.push("KET_QUA_KHAM_SAN_PHU_KHOA", "KHAM_SAN_PHU_KHOA_PL");
        }

        allKeys.forEach(key => {
          let val1 = String(p1[key] ?? "").trim();
          let val2 = String(p2[key] ?? "").trim();
          if (key.toUpperCase().includes("BMI")) { val1 = val1.replace(/,/g, "."); val2 = val2.replace(/,/g, "."); }
          if (key.toUpperCase().includes("BENH_TAT")) {
            const emptyKeywords = ["không", "không có", "null", "none", ""];
            if (emptyKeywords.includes(val1.toLowerCase())) val1 = "";
            if (emptyKeywords.includes(val2.toLowerCase())) val2 = "";
          }
          const hearingDefaults: Record<string, string> = {
            TAI_TRAI_NOI_THUONG: "5",
            TAI_PHAI_NOI_THUONG: "5",
            TAI_TRAI_NOI_THAM: "0.5",
            TAI_PHAI_NOI_THAM: "0.5"
          };
          if (docType === "ADULT_18" && hearingDefaults[key]) {
            // Giá trị mặc định cố định: không cho OCR nhầm 15/10 ghi đè 5/0.5.
            val1 = hearingDefaults[key];
            val2 = hearingDefaults[key];
          }
          const isAgreed = val1.toLowerCase() === val2.toLowerCase();
          patientReconciled[key] = {
            m1: val1,
            m2: val2,
            final: isAgreed ? val1 : (val1 || val2),
            status: isAgreed ? "AGREED" : "DISAGREED"
          };
        });
        return patientReconciled as PatientData;
      });

      setReconciledData(allReconciledData);
      setPatientIndex(0);
      setGlobalImageIndex(0);
      const needsReview = allReconciledData.filter(p => p._groupingWarning).length;
      setStatus(`🎉 Hoàn tất ${allReconciledData.length} hồ sơ. ${needsReview ? `Có ${needsReview} hồ sơ cần kiểm tra do thiếu kết quả từ một model.` : "M1 và M2 đã được đối chiếu theo đúng ranh giới OCR."}${skippedIncompleteNotice}`);
    } catch (error: any) {
      console.error(error);
      setStatus("❌ Lỗi: " + error.message);
    } finally {
      setLoading(false);
    }
  }

  // --- XÓA HỒ SƠ BỆNH NHÂN ---
  async function confirmDeletePatient() {
    if (pendingDeleteId === null) return;

    const deleteIndex = reconciledData.findIndex(p => p._id === pendingDeleteId);
    if (deleteIndex === -1) {
      setPendingDeleteId(null);
      return;
    }

    const updated = reconciledData.filter(p => p._id !== pendingDeleteId);
    setReconciledData(updated);

    // Giữ chỉ số đang chọn hợp lệ sau khi xóa.
    if (updated.length === 0) {
      setPatientIndex(0);
      setGlobalImageIndex(0);
      await del("saved_reconciled_data");
    } else if (patientIndex > deleteIndex) {
      setPatientIndex(patientIndex - 1);
    } else if (patientIndex === deleteIndex) {
      setPatientIndex(Math.min(deleteIndex, updated.length - 1));
    }

    setPendingDeleteId(null);
  }

  // --- 6. CÁC HÀM TIỆN ÍCH KHÁC ---
  function handleFieldChange(key: string, newValue: string) {
    const updated = [...reconciledData];
    updated[patientIndex][key].final = newValue;
    updated[patientIndex][key].status = "AGREED";
    setReconciledData(updated);
  }

  const totalConflicts = useMemo(() => {
    let count = 0;
    reconciledData.forEach(p => {
      Object.keys(p || {}).forEach(k => {
        if (k !== "_id" && k !== "patientImages" && k !== "_groupingWarning" &&
            (docType !== "ADULT_18" || ADULT_CLINICAL_FIELD_SET.has(k)) &&
            p[k]?.status === "DISAGREED") {
          count++;
        }
      });
    });
    return count;
  }, [reconciledData, docType]);

  async function exportToExcel() {
    if (reconciledData.length === 0 || totalConflicts > 0) return;

    try {
      if (docType === "ADULT_18") {
        // Dùng chính workbook mẫu để giữ nguyên tiêu đề, hàng hướng dẫn, độ rộng,
        // màu sắc, viền, căn lề và định dạng ô. Loại đúng E:X (Họ tên -> Loại hình KCB).
        const templateResponse = await fetch("/templates/form-chuan.xlsx");
        if (!templateResponse.ok) {
          throw new Error("Không tải được mẫu Excel. Hãy đặt form-chuan.xlsx tại public/templates/form-chuan.xlsx.");
        }

        const ExcelJSModule: any = await import("exceljs");
        const ExcelJS = ExcelJSModule.default || ExcelJSModule;
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(await templateResponse.arrayBuffer());

        const sourceWorksheet = workbook.getWorksheet("Trang_tính1") || workbook.worksheets[0];
        if (!sourceWorksheet) throw new Error("File mẫu không có sheet dữ liệu.");

        const outputWorkbook = new ExcelJS.Workbook();
        const worksheet = outputWorkbook.addWorksheet(sourceWorksheet.name || "Trang_tính1");
        const templateDataStartRow = 4; // Hàng 1: tiêu đề, 2: mã trường, 3: hướng dẫn.
        const requiredLastRow = templateDataStartRow + reconciledData.length - 1;

        // Copy đúng A:D và Y:CY sang workbook mới. Cách này loại bỏ hẳn E:X
        // mà không phải splice cột, tránh làm xê dịch merge/range trong file mẫu.
        const sourceColumns = [1, 2, 3, 4,5, ...Array.from({ length: 79 }, (_, index) => 25 + index)];
        const columnCount = sourceColumns.length; // 83 cột sau khi bỏ E:X.

        worksheet.properties = { ...sourceWorksheet.properties };
        worksheet.views = sourceWorksheet.views ? JSON.parse(JSON.stringify(sourceWorksheet.views)) : [];
        worksheet.pageSetup = { ...sourceWorksheet.pageSetup };
        worksheet.pageMargins = sourceWorksheet.pageMargins ? { ...sourceWorksheet.pageMargins } : undefined;
        worksheet.headerFooter = sourceWorksheet.headerFooter ? { ...sourceWorksheet.headerFooter } : undefined;
        worksheet.state = sourceWorksheet.state;

        sourceColumns.forEach((sourceCol, index) => {
          const sourceColumn = sourceWorksheet.getColumn(sourceCol);
          const outputColumn = worksheet.getColumn(index + 1);
          if (sourceColumn.width) outputColumn.width = sourceColumn.width;
          if (sourceColumn.hidden) outputColumn.hidden = sourceColumn.hidden;
          if (sourceColumn.outlineLevel) outputColumn.outlineLevel = sourceColumn.outlineLevel;
          if (sourceColumn.style) outputColumn.style = { ...sourceColumn.style };
        });

        // Sao chép nguyên giá trị + style 3 hàng đầu; các hàng dữ liệu lấy style
        // của đúng hàng tương ứng trong mẫu (nếu vượt số dòng mẫu thì dùng hàng 4).
        for (let rowNumber = 1; rowNumber <= requiredLastRow; rowNumber++) {
          const sourceRowNumber = rowNumber <= sourceWorksheet.rowCount ? rowNumber : templateDataStartRow;
          const sourceRow = sourceWorksheet.getRow(sourceRowNumber);
          const outputRow = worksheet.getRow(rowNumber);
          if (sourceRow.height) outputRow.height = sourceRow.height;
          outputRow.hidden = sourceRow.hidden;
          outputRow.outlineLevel = sourceRow.outlineLevel;

          sourceColumns.forEach((sourceCol, index) => {
            const sourceCell = sourceRow.getCell(sourceCol);
            const outputCell = outputRow.getCell(index + 1);
            outputCell.style = JSON.parse(JSON.stringify(sourceCell.style || {}));
            outputCell.value = rowNumber <= 3 ? sourceCell.value : null;
          });
        }

        // Mẫu có một ô tiêu đề được gộp theo chiều dọc ở CV1:CV2.
        // Sau khi bỏ E:X, cột CV chuyển thành CB; giữ nguyên merge tương ứng.
        worksheet.mergeCells("CC1:CC2");
        if (worksheet.pageSetup) worksheet.pageSetup.printArea = `A1:CF${requiredLastRow}`;

        const fieldKeyRow = worksheet.getRow(2);
        reconciledData.forEach((patient, patientIndex) => {
          const outputRow = worksheet.getRow(templateDataStartRow + patientIndex);
          for (let col = 1; col <= columnCount; col++) {
            const key = String(fieldKeyRow.getCell(col).value ?? "").trim();
            if (col === 1) {
              // Cột TT không có mã trường ở hàng 2; tự đánh số thứ tự.
              outputRow.getCell(col).value = patientIndex + 1;
              continue;
            }

            // Cột Dịch vụ cận lâm sàng trong mẫu không có mã trường ở hàng 2;
            // trường này được nhập tại danh mục riêng nên để trống ở sheet này.
            if (!key) {
              outputRow.getCell(col).value = "";
              continue;
            }

            const field = patient[key];
            const finalValue = field && typeof field === "object" && "final" in field
              ? field.final
              : (typeof field === "string" || typeof field === "number" ? field : "");
            outputRow.getCell(col).value = finalValue ?? "";
          }
        });

        const output = await outputWorkbook.xlsx.writeBuffer();
        const blob = new Blob([new Uint8Array(output as any)], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "KSK_Theo_Mau.xlsx";
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        setStatus(`✅ Đã xuất ${reconciledData.length} hồ sơ theo đúng mẫu Excel; đã loại các cột Họ tên đến Loại hình khám chữa bệnh.`);
        return;
      }

      // Giữ nguyên cách xuất cũ cho loại hồ sơ học sinh, không áp mẫu người lớn.
      const exportArr = reconciledData.map(p => {
        const row: any = {};
        Object.keys(p || {}).forEach(k => {
          if (k !== "_id" && k !== "patientImages" && k !== "_groupingWarning") {
            row[k] = p[k]?.final || "";
          }
        });
        return row;
      });
      const ws = XLSX.utils.json_to_sheet(exportArr);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "KhamSucKhoe");
      XLSX.writeFile(wb, "Data_KhamSucKhoe.xlsx");
    } catch (error: any) {
      console.error("Lỗi xuất Excel:", error);
      setStatus(`❌ Không thể xuất Excel: ${error?.message || "Lỗi không xác định"}`);
    }
  }

  const isWorkspaceReady = reconciledData.length > 0;
  const currentPatientData = isWorkspaceReady ? reconciledData[patientIndex] : null;
  const currentImageUrl = allPdfPages[globalImageIndex]?.displayBase64 || "";
  const patientName = currentPatientData?.HO_TEN?.final || currentPatientData?.HO_TEN?.m1 || `Bệnh nhân #${patientIndex + 1}`;

  return (
    <div style={{ padding: "20px", fontFamily: "sans-serif", maxWidth: "1600px", margin: "0 auto" }}>
      
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <h2>Hệ Thống Bóc Tách Hồ Sơ Hàng Loạt</h2>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          
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

      {loading && (
        <div style={{ marginTop: "-10px", marginBottom: "20px", padding: "10px 12px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "8px", color: "#1e40af", fontSize: "14px" }}>
          <strong>⏳ Tác vụ đang chạy.</strong> Bạn có thể chuyển sang tab Google hoặc tab khác để làm việc. {isTabHidden ? "Tab xử lý hiện đang ở chế độ nền." : "Khi chuyển tab, tiêu đề tab sẽ đổi thành ‘Đang chạy nền’."} Vui lòng không đóng tab này hoặc đóng trình duyệt cho đến khi hoàn tất.
        </div>
      )}

      {isWorkspaceReady && currentPatientData && (
        <div style={{ display: "flex", gap: "20px", height: "80vh" }}>
          
          {/* CỘT 1: DANH SÁCH */}
          <div style={{ width: "250px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: "8px", overflowY: "auto" }}>
            <h3 style={{ padding: "15px", margin: 0, borderBottom: "1px solid #e5e7eb", background: "#f9fafb" }}>
              Danh sách ({reconciledData.length})
            </h3>
            {reconciledData.map((p, idx) => {
              const name = p.HO_TEN?.final || p.HO_TEN?.m1 || `Bệnh nhân #${idx + 1}`;
              // Trạng thái biểu tượng phải dùng đúng cùng tiêu chí với totalConflicts/nút Xuất Excel:
              // chỉ tính các trường thực sự hiển thị và cần người dùng xử lý.
              // Trước đây đoạn này tính cả trường hành chính/metadata bị ẩn, khiến người dùng
              // đã xử lý hết phần khám nhưng biểu tượng vẫn báo đỏ.
              const unresolvedClinicalFields = Object.keys(p || {}).filter(k =>
                k !== "_id" &&
                k !== "patientImages" &&
                k !== "_groupingWarning" &&
                (docType !== "ADULT_18" || ADULT_CLINICAL_FIELD_SET.has(k)) &&
                p[k]?.status === "DISAGREED"
              );
              const hasConflict = unresolvedClinicalFields.length > 0;
              const hasModelWarning = Boolean(p._groupingWarning);

              return (
                <div
                  key={p._id}
                  onClick={() => setPatientIndex(idx)}
                  style={{
                    padding: "12px 10px", cursor: "pointer", borderBottom: "1px solid #f3f4f6",
                    background: patientIndex === idx ? "#eff6ff" : "transparent",
                    borderLeft: patientIndex === idx ? "4px solid #3b82f6" : "4px solid transparent",
                    display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px"
                  }}
                >
                  <span style={{ fontWeight: patientIndex === idx ? "bold" : "normal", fontSize: "14px", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{name}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                    {hasConflict ? (
                      <span title={`${unresolvedClinicalFields.length} trường khám chưa được xác nhận`}>
                        <AlertTriangle size={16} color="#ef4444" />
                      </span>
                    ) : hasModelWarning ? (
                      <span title="Một model chưa trả kết quả cho hồ sơ này; cần kiểm tra riêng">
                        <AlertTriangle size={16} color="#f59e0b" />
                      </span>
                    ) : (
                      <span title="Đã xử lý hết các trường cần đối chiếu">
                        <CheckCircle size={16} color="#10b981" />
                      </span>
                    )}
                    <button
                      type="button"
                      title={`Xóa hồ sơ ${name}`}
                      aria-label={`Xóa hồ sơ ${name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDeleteId(p._id);
                      }}
                      style={{
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        width: "30px", height: "30px", border: "1px solid #fecaca",
                        borderRadius: "6px", background: "#fff", color: "#dc2626", cursor: "pointer"
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* CỘT 2: TRÌNH XEM ẢNH TOÀN CỤC */}
          <div style={{ flex: 1, background: "#f9fafb", borderRadius: "8px", border: "1px solid #e5e7eb", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            
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

              <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
                <button onClick={handleZoomOut} style={{ padding: "6px 12px", cursor: "pointer", borderRadius: "6px", border: "1px solid #d1d5db" }}>➖</button>
                <button onClick={handleResetZoom} style={{ padding: "6px 12px", cursor: "pointer", borderRadius: "6px", border: "1px solid #d1d5db", minWidth: "60px" }}>
                  {Math.round(zoom * 100)}%
                </button>
                <button onClick={handleZoomIn} style={{ padding: "6px 12px", cursor: "pointer", borderRadius: "6px", border: "1px solid #d1d5db" }}>➕</button>
              </div>
            </div>
            
            <div 
              style={{ 
                flex: 1, 
                position: "relative",
                overflow: "hidden", 
                cursor: isDragging ? "grabbing" : "grab",
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
                   draggable={false}
                   style={{ 
                     position: "absolute",
                     transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`,
                     transformOrigin: "center center",
                     transition: isDragging ? "none" : "transform 0.1s ease-out",
                     maxWidth: "100%", 
                     height: "auto",
                     left: 0, right: 0, top: 0, bottom: 0, margin: "auto",
                     pointerEvents: "none"
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
             <div 
               ref={formScrollRef} 
               style={{ flex: 1, overflowY: "auto", padding: "15px", display: "flex", flexDirection: "column", gap: "15px" }}
             >
               {Object.keys(currentPatientData || {}).map(key => {
                 if (key === "_id" || key === "patientImages" || key === "_groupingWarning") return null;
                 if (docType === "ADULT_18" && (ADMINISTRATIVE_FIELDS.has(key) || !ADULT_CLINICAL_FIELD_SET.has(key))) return null;
                 const field = currentPatientData[key];
                 const isAgreed = field?.status === "AGREED";

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
                     
                     {!isAgreed && (
                       <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
                         <button 
                            onClick={() => handleFieldChange(key, field.m1)}
                            style={{ flex: 1, padding: "8px", fontSize: "12px", background: "#dbeafe", color: "#1e3a8a", border: "1px solid #bfdbfe", borderRadius: "6px", cursor: "pointer", textAlign: "left" }}
                         >
                           <strong>M1:</strong> {field?.m1 || "(Trống)"}
                         </button>
                         <button 
                            onClick={() => handleFieldChange(key, field.m2)}
                            style={{ flex: 1, padding: "8px", fontSize: "12px", background: "#e0e7ff", color: "#3730a3", border: "1px solid #c7d2fe", borderRadius: "6px", cursor: "pointer", textAlign: "left" }}
                         >
                           <strong>M2:</strong> {field?.m2 || "(Trống)"}
                         </button>
                       </div>
                     )}

                     <textarea
                        value={field?.final || ""}
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

      {/* Hộp thoại xác nhận xóa hồ sơ */}
      {pendingDeleteId !== null && (() => {
        const patientToDelete = reconciledData.find(p => p._id === pendingDeleteId);
        const deleteName = patientToDelete?.HO_TEN?.final || patientToDelete?.HO_TEN?.m1 || "Bệnh nhân chưa rõ tên";
        return (
          <div
            onClick={() => setPendingDeleteId(null)}
            style={{
              position: "fixed", inset: 0, zIndex: 1000, background: "rgba(15, 23, 42, 0.55)",
              display: "flex", alignItems: "center", justifyContent: "center", padding: "20px"
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-patient-title"
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%", maxWidth: "420px", background: "#fff", borderRadius: "12px",
                padding: "24px", boxShadow: "0 20px 50px rgba(0,0,0,0.25)"
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
                <div style={{
                  width: "40px", height: "40px", borderRadius: "50%", background: "#fee2e2",
                  color: "#dc2626", display: "flex", alignItems: "center", justifyContent: "center"
                }}>
                  <Trash2 size={20} />
                </div>
                <h3 id="delete-patient-title" style={{ margin: 0, fontSize: "18px", color: "#111827" }}>Xác nhận xóa hồ sơ</h3>
                <button
                  type="button"
                  aria-label="Đóng"
                  onClick={() => setPendingDeleteId(null)}
                  style={{ marginLeft: "auto", border: "none", background: "transparent", color: "#6b7280", cursor: "pointer" }}
                >
                  <X size={20} />
                </button>
              </div>
              <p style={{ color: "#374151", lineHeight: 1.5, margin: "0 0 8px" }}>
                Bạn có chắc chắn muốn xóa hồ sơ của:
              </p>
              <p style={{ fontWeight: "bold", color: "#111827", overflowWrap: "anywhere", margin: "0 0 18px" }}>
                {deleteName}?
              </p>
              <p style={{ color: "#b91c1c", fontSize: "13px", margin: "0 0 22px" }}>
                Hồ sơ này sẽ bị xóa khỏi danh sách và dữ liệu đã lưu trên trình duyệt. Thao tác này không thể hoàn tác.
              </p>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                <button
                  type="button"
                  onClick={() => setPendingDeleteId(null)}
                  style={{
                    padding: "9px 16px", border: "1px solid #d1d5db", borderRadius: "7px",
                    background: "#fff", color: "#374151", cursor: "pointer", fontWeight: 600
                  }}
                >
                  Hủy
                </button>
                <button
                  type="button"
                  onClick={confirmDeletePatient}
                  style={{
                    padding: "9px 16px", border: "none", borderRadius: "7px",
                    background: "#dc2626", color: "#fff", cursor: "pointer", fontWeight: 600
                  }}
                >
                  Xóa hồ sơ
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}