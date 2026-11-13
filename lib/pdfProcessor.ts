import * as pdfjsLib from "pdfjs-dist";

// Dùng worker cùng phiên bản với pdfjs-dist đang cài trong dự án.
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

export type DocumentMarker = "PATIENT_START" | "LAB_START" | null;

export interface PdfProcessingMetrics {
  pdfLoadMs: number;
  workerInitMs: number;
  renderMs: number;
  blankCheckMs: number;
  headerOcrMs: number;
  footerOcrMs: number;
  imageEncodeMs: number;
  pageProcessingMs: number;
  totalMs: number;
  totalPages: number;
  validPages: number;
  headerOcrCalls: number;
  footerOcrCalls: number;
  footerCandidatePages: number;
}

export interface ValidPage {
  /** Số trang gốc trong PDF, bắt đầu từ 1. */
  pageNumber: number;
  /** Ảnh JPEG chất lượng tối ưu để gửi Gemini. */
  base64: string;
  /** Ảnh JPEG rõ hơn để hiển thị trên giao diện. */
  displayBase64: string;
  /** Dấu mốc nhận diện từ OCR vùng đầu trang. */
  documentMarker?: DocumentMarker;
  /** Văn bản OCR vùng đầu trang, phục vụ nhận diện trang bắt đầu hồ sơ/phiếu xét nghiệm. */
  headerText?: string;
  /** Trang có dấu hiệu kết luận cuối cùng của phiếu khám sức khỏe. */
  patientEnd?: boolean;
}

function hasVisibleContent(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  sampleCanvas: HTMLCanvasElement,
  sampleContext: CanvasRenderingContext2D
): boolean {
  const sampleWidth = Math.min(180, width);
  const sampleHeight = Math.max(1, Math.round((height / width) * sampleWidth));
  sampleCanvas.width = sampleWidth;
  sampleCanvas.height = sampleHeight;

  sampleContext.drawImage(context.canvas, 0, 0, sampleWidth, sampleHeight);
  const pixels = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight).data;
  let darkPixels = 0;
  const totalPixels = sampleWidth * sampleHeight;

  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] < 245 || pixels[i + 1] < 245 || pixels[i + 2] < 245) darkPixels++;
  }

  return darkPixels / totalPixels >= 0.0005;
}

function normalizeOcrText(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/Đ/g, "D")
    .replace(/đ/g, "d")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyHeader(text: string): DocumentMarker {
  const normalized = normalizeOcrText(text);

  // Tiêu đề mở đầu biểu mẫu khám sức khỏe người từ đủ 18 tuổi.
  const hasHealthTitle = normalized.includes("GIAY KHAM SUC KHOE");
  const hasAdultPhrase = normalized.includes("DINH KY") ||
    normalized.includes("TU DU 18 TUOI") ||
    normalized.includes("NGUOI TU DU 18");
  if (hasHealthTitle && hasAdultPhrase) return "PATIENT_START";

  // Tiêu đề trang đầu của phiếu xét nghiệm. Đây chỉ là dấu nhận diện loại trang,
  // không còn là điều kiện bắt buộc để kết thúc một hồ sơ khám.
  if (normalized.includes("PHIEU KET QUA XET NGHIEM") ||
      (normalized.includes("PHIEU") && normalized.includes("KET QUA XET NGHIEM"))) {
    return "LAB_START";
  }

  return null;
}

/**
 * Nhận diện trang kết luận bằng nội dung ở phần cuối trang, không dựa vào
 * số trang cố định hay sự xuất hiện của phiếu xét nghiệm.
 * Cần có dấu hiệu phân loại sức khỏe chung và ít nhất một dấu hiệu kết luận/bác sĩ
 * để hạn chế nhầm các trang khám chuyên khoa hoặc trang xét nghiệm.
 */
function classifyPatientEnd(footerText: string, headerText: string): boolean {
  const normalized = normalizeOcrText(`${footerText} ${headerText}`);
  const hasOverallClassification =
    normalized.includes("PHAN LOAI SUC KHOE") ||
    normalized.includes("XEP LOAI SUC KHOE") ||
    normalized.includes("PHAN LOAI SK");
  const hasConclusion =
    normalized.includes("KET LUAN") ||
    normalized.includes("KET LUAN BENH");
  const hasDoctorSign =
    normalized.includes("BAC SI KHAM") ||
    normalized.includes("NGUOI KHAM") ||
    normalized.includes("CHU KY BAC SI") ||
    normalized.includes("BAC SI");

  return (hasOverallClassification && (hasConclusion || hasDoctorSign)) ||
    (hasConclusion && hasDoctorSign);
}

/**
 * Đọc PDF scan, lọc trang trắng và OCR hai vùng có mục đích riêng:
 * - Vùng đầu trang: nhận diện bắt đầu phiếu khám và tiêu đề phiếu xét nghiệm.
 * - Vùng cuối trang: nhận diện kết luận cuối cùng/phân loại sức khỏe chung.
 * Điểm kết thúc hồ sơ được xác định theo nội dung kết luận, không theo số trang
 * cố định và không bắt buộc phải có phiếu xét nghiệm.
 */
export async function extractAndFilterPages(
  file: File,
  onProgress?: (processedPages: number, totalPages: number, metrics?: PdfProcessingMetrics) => void
): Promise<ValidPage[][]> {
  const totalStartedAt = Date.now();
  const metrics: PdfProcessingMetrics = {
    pdfLoadMs: 0,
    workerInitMs: 0,
    renderMs: 0,
    blankCheckMs: 0,
    headerOcrMs: 0,
    footerOcrMs: 0,
    imageEncodeMs: 0,
    pageProcessingMs: 0,
    totalMs: 0,
    totalPages: 0,
    validPages: 0,
    headerOcrCalls: 0,
    footerOcrCalls: 0,
    footerCandidatePages: 0
  };
  const pdfLoadStartedAt = Date.now();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  metrics.pdfLoadMs = Date.now() - pdfLoadStartedAt;
  metrics.totalPages = pdf.numPages;
  const validPages: ValidPage[] = [];
  const ocrWorkers: any[] = [];
  let processedPages = 0;

  // Hai worker chỉ được bật cho PDF dài và máy có đủ luồng CPU.
  // Máy yếu/PDF ngắn vẫn dùng một worker như luồng cũ để tránh tăng tải bộ nhớ.
  const logicalCores = typeof navigator !== "undefined"
    ? (navigator.hardwareConcurrency || 2)
    : 2;
  const desiredWorkerCount = pdf.numPages >= 20 && logicalCores >= 4 ? 2 : 1;

  try {
    const workerInitStartedAt = Date.now();
    const { createWorker } = await import("tesseract.js");

    // Nếu không khởi tạo được worker thứ hai, tự động quay về một worker.
    for (let i = 0; i < desiredWorkerCount; i++) {
      let worker: any = null;
      try {
        worker = await createWorker("vie");
        await worker.setParameters({ tessedit_pageseg_mode: "6" });
        ocrWorkers.push(worker);
      } catch (workerError) {
        if (worker) await worker.terminate().catch(() => undefined);
        if (ocrWorkers.length === 0) throw workerError;
        console.warn("Không khởi tạo được OCR worker bổ sung; tiếp tục bằng số worker hiện có.", workerError);
        break;
      }
    }

    metrics.workerInitMs = Date.now() - workerInitStartedAt;

    const processPage = async (pageNumber: number, ocrWorker: any): Promise<ValidPage | null> => {
      const pageStartedAt = Date.now();
      const page = await pdf.getPage(pageNumber);
      const displayCanvas = document.createElement("canvas");
      const aiCanvas = document.createElement("canvas");
      const headerCanvas = document.createElement("canvas");
      const footerCanvas = document.createElement("canvas");
      const sampleCanvas = document.createElement("canvas");

      try {
        const displayContext = displayCanvas.getContext("2d", { willReadFrequently: true });
        const aiContext = aiCanvas.getContext("2d", { willReadFrequently: true });
        const headerContext = headerCanvas.getContext("2d", { willReadFrequently: true });
        const footerContext = footerCanvas.getContext("2d", { willReadFrequently: true });
        const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });

        if (!displayContext || !aiContext || !headerContext || !footerContext || !sampleContext) {
          throw new Error("Trình duyệt không thể khởi tạo canvas để đọc PDF.");
        }

        // Giữ nguyên độ phân giải và chất lượng ảnh hiển thị như phiên bản trước.
        const displayViewport = page.getViewport({ scale: 1.8 });
        displayCanvas.width = Math.ceil(displayViewport.width);
        displayCanvas.height = Math.ceil(displayViewport.height);
        displayContext.fillStyle = "#ffffff";
        displayContext.fillRect(0, 0, displayCanvas.width, displayCanvas.height);
        const renderStartedAt = Date.now();
        await page.render({ canvasContext: displayContext, viewport: displayViewport } as any).promise;
        metrics.renderMs += Date.now() - renderStartedAt;

        const blankCheckStartedAt = Date.now();
        const pageHasVisibleContent = hasVisibleContent(
          displayContext,
          displayCanvas.width,
          displayCanvas.height,
          sampleCanvas,
          sampleContext
        );
        metrics.blankCheckMs += Date.now() - blankCheckStartedAt;
        if (!pageHasVisibleContent) return null;

        // Chỉ tạo ảnh ở lượt đầu. OCR chân trang được thực hiện ở lượt hai,
        // sau khi đã biết trang nào thực sự thuộc phiếu khám (không OCR phần xét nghiệm).
        const displayEncodeStartedAt = Date.now();
        const displayBase64 = displayCanvas.toDataURL("image/jpeg", 0.82);
        metrics.imageEncodeMs += Date.now() - displayEncodeStartedAt;

        // Giữ nguyên vùng OCR 34% đầu trang, chiều rộng tối đa 760px và PSM 6.
        const headerSourceHeight = Math.max(1, Math.floor(displayCanvas.height * 0.34));
        const headerScale = Math.min(1, 760 / displayCanvas.width);
        headerCanvas.width = Math.max(1, Math.round(displayCanvas.width * headerScale));
        headerCanvas.height = Math.max(1, Math.round(headerSourceHeight * headerScale));
        headerContext.fillStyle = "#ffffff";
        headerContext.fillRect(0, 0, headerCanvas.width, headerCanvas.height);
        headerContext.drawImage(
          displayCanvas,
          0, 0, displayCanvas.width, headerSourceHeight,
          0, 0, headerCanvas.width, headerCanvas.height
        );

        let headerText = "";
        const headerOcrStartedAt = Date.now();
        try {
          const ocrResult = await ocrWorker.recognize(headerCanvas);
          metrics.headerOcrCalls++;
          headerText = ocrResult?.data?.text || "";
        } catch (ocrError) {
          // Giữ nguyên hành vi cũ: lỗi OCR một trang không làm hỏng toàn bộ PDF.
          console.warn(`Không OCR được vùng đầu trang ${pageNumber}:`, ocrError);
        } finally {
          metrics.headerOcrMs += Date.now() - headerOcrStartedAt;
        }

        const documentMarker = classifyHeader(headerText);

        // Chưa OCR chân trang tại đây. Sau khi OCR tiêu đề toàn bộ PDF,
        // lượt hai chỉ OCR các trang nằm trong phạm vi phiếu khám.
        const patientEnd = false;

        // Giữ nguyên cách tạo ảnh AI từ canvas gốc trước nén, scale 1.0 và JPEG 0.62.
        const aiViewport = page.getViewport({ scale: 1.0 });
        aiCanvas.width = Math.ceil(aiViewport.width);
        aiCanvas.height = Math.ceil(aiViewport.height);
        aiContext.fillStyle = "#ffffff";
        aiContext.fillRect(0, 0, aiCanvas.width, aiCanvas.height);
        aiContext.drawImage(
          displayCanvas,
          0, 0, displayCanvas.width, displayCanvas.height,
          0, 0, aiCanvas.width, aiCanvas.height
        );

        const aiEncodeStartedAt = Date.now();
        const base64 = aiCanvas.toDataURL("image/jpeg", 0.62);
        metrics.imageEncodeMs += Date.now() - aiEncodeStartedAt;
        return { pageNumber, base64, displayBase64, documentMarker, headerText, patientEnd };
      } finally {
        page.cleanup();
        // Thu hồi bộ nhớ canvas ngay sau mỗi trang, kể cả khi OCR/render gặp lỗi.
        displayCanvas.width = 0;
        displayCanvas.height = 0;
        aiCanvas.width = 0;
        aiCanvas.height = 0;
        headerCanvas.width = 0;
        headerCanvas.height = 0;
        footerCanvas.width = 0;
        footerCanvas.height = 0;
        sampleCanvas.width = 0;
        sampleCanvas.height = 0;

        processedPages++;
        metrics.pageProcessingMs += Date.now() - pageStartedAt;
        if (onProgress && (
          processedPages === 1 ||
          processedPages % 2 === 0 ||
          processedPages === pdf.numPages
        )) {
          onProgress(processedPages, pdf.numPages, { ...metrics, totalMs: Date.now() - totalStartedAt });
        }
      }
    };

    // Xử lý theo từng nhóm nhỏ, giữ nguyên thứ tự trang trong kết quả.
    // Promise.allSettled bảo đảm cả trang còn lại trong nhóm kết thúc và được dọn
    // tài nguyên trước khi xử lý lỗi, tránh terminate worker khi nó còn đang OCR.
    const concurrency = Math.max(1, ocrWorkers.length);
    for (let firstPage = 1; firstPage <= pdf.numPages; firstPage += concurrency) {
      const pageNumbers = Array.from(
        { length: Math.min(concurrency, pdf.numPages - firstPage + 1) },
        (_, offset) => firstPage + offset
      );

      const settled = await Promise.allSettled(
        pageNumbers.map((pageNumber, index) => processPage(pageNumber, ocrWorkers[index]))
      );

      const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
      if (failed) throw failed.reason;

      // Promise.allSettled giữ thứ tự đầu vào; trang trắng vẫn được lọc như cũ.
      for (const item of settled) {
        if (item.status === "fulfilled" && item.value) validPages.push(item.value);
      }
    }

    // Xác định vùng phiếu khám theo các dấu mốc đã OCR ở đầu trang.
    // Khi gặp PHIẾU KẾT QUẢ XÉT NGHIỆM, bỏ qua toàn bộ phần xét nghiệm tiếp theo
    // cho đến khi gặp PATIENT_START của người kế tiếp. Nhờ đó không cần OCR
    // chân trang của các trang xét nghiệm/phụ lục.
    const footerTargetPages: ValidPage[] = [];
    let insidePatientForm = false;
    for (const validPage of validPages) {
      if (validPage.documentMarker === "PATIENT_START") {
        insidePatientForm = true;
      }
      if (validPage.documentMarker === "LAB_START") {
        insidePatientForm = false;
        continue;
      }
      if (insidePatientForm) footerTargetPages.push(validPage);
    }
    metrics.footerCandidatePages = footerTargetPages.length;

    // OCR chân trang chỉ trên các trang phiếu khám. Giữ nguyên crop 35%-100%,
    // chiều rộng tối đa 1000px và PSM 6 để không thay đổi tiêu chí nhận diện kết luận.
    const processFooter = async (validPage: ValidPage, ocrWorker: any): Promise<void> => {
      const footerStartedAt = Date.now();
      const page = await pdf.getPage(validPage.pageNumber);
      const footerCanvas = document.createElement("canvas");
      try {
        const footerContext = footerCanvas.getContext("2d", { willReadFrequently: true });
        if (!footerContext) throw new Error("Trình duyệt không thể khởi tạo canvas OCR chân trang.");

        const viewport = page.getViewport({ scale: 1.8 });
        const sourceCanvas = document.createElement("canvas");
        try {
          const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
          if (!sourceContext) throw new Error("Trình duyệt không thể khởi tạo canvas đọc PDF.");
          sourceCanvas.width = Math.ceil(viewport.width);
          sourceCanvas.height = Math.ceil(viewport.height);
          sourceContext.fillStyle = "#ffffff";
          sourceContext.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
          const renderStartedAt = Date.now();
          await page.render({ canvasContext: sourceContext, viewport } as any).promise;
          metrics.renderMs += Date.now() - renderStartedAt;

          const footerSourceY = Math.floor(sourceCanvas.height * 0.35);
          const footerSourceHeight = Math.max(1, sourceCanvas.height - footerSourceY);
          const footerScale = Math.min(1, 1000 / sourceCanvas.width);
          footerCanvas.width = Math.max(1, Math.round(sourceCanvas.width * footerScale));
          footerCanvas.height = Math.max(1, Math.round(footerSourceHeight * footerScale));
          footerContext.fillStyle = "#ffffff";
          footerContext.fillRect(0, 0, footerCanvas.width, footerCanvas.height);
          footerContext.drawImage(
            sourceCanvas,
            0, footerSourceY, sourceCanvas.width, footerSourceHeight,
            0, 0, footerCanvas.width, footerCanvas.height
          );

          const footerOcrStartedAt = Date.now();
          try {
            const footerResult = await ocrWorker.recognize(footerCanvas);
            metrics.footerOcrCalls++;
            const footerText = footerResult?.data?.text || "";
            validPage.patientEnd = classifyPatientEnd(footerText, validPage.headerText || "");
          } catch (ocrError) {
            console.warn(`Không OCR được vùng cuối trang ${validPage.pageNumber}:`, ocrError);
          } finally {
            metrics.footerOcrMs += Date.now() - footerOcrStartedAt;
          }
        } finally {
          sourceCanvas.width = 0;
          sourceCanvas.height = 0;
        }
      } finally {
        page.cleanup();
        footerCanvas.width = 0;
        footerCanvas.height = 0;
        metrics.pageProcessingMs += Date.now() - footerStartedAt;
      }
    };

    for (let offset = 0; offset < footerTargetPages.length; offset += ocrWorkers.length) {
      const group = footerTargetPages.slice(offset, offset + ocrWorkers.length);
      await Promise.all(group.map((validPage, index) => processFooter(validPage, ocrWorkers[index])));
    }
  } finally {
    await Promise.allSettled(ocrWorkers.map(worker => worker.terminate()));
    await pdf.cleanup();
  }

  metrics.validPages = validPages.length;
  metrics.totalMs = Date.now() - totalStartedAt;
  console.groupCollapsed("[KSK Performance] PDF processing");
  console.table(metrics);
  console.groupEnd();

  return validPages.length > 0 ? [validPages] : [];
}
