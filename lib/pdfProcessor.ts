import * as pdfjsLib from "pdfjs-dist";

// Dùng worker cùng phiên bản với pdfjs-dist đang cài trong dự án.
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

export type DocumentMarker = "PATIENT_START" | "LAB_START" | null;

export interface ValidPage {
  /** Số trang gốc trong PDF, bắt đầu từ 1. */
  pageNumber: number;
  /** Ảnh JPEG chất lượng tối ưu để gửi Gemini. */
  base64: string;
  /** Ảnh JPEG rõ hơn để hiển thị trên giao diện. */
  displayBase64: string;
  /** Dấu mốc nhận diện từ OCR vùng đầu trang. */
  documentMarker?: DocumentMarker;
  /** Văn bản OCR vùng đầu trang, phục vụ kiểm tra khi cần. */
  headerText?: string;
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

  // Tiêu đề trang đầu của phiếu xét nghiệm.
  if (normalized.includes("PHIEU KET QUA XET NGHIEM") ||
      (normalized.includes("PHIEU") && normalized.includes("KET QUA XET NGHIEM"))) {
    return "LAB_START";
  }

  return null;
}

/**
 * Đọc PDF scan, lọc trang trắng và chỉ OCR vùng đầu trang để tìm hai dấu mốc:
 * - GIẤY KHÁM SỨC KHỎE...: bắt đầu bệnh nhân.
 * - PHIẾU KẾT QUẢ XÉT NGHIỆM: dấu kết thúc phần khám của bệnh nhân.
 *   Trang xét nghiệm và các trang xét nghiệm lưu trữ tiếp theo không được gửi Gemini.
 * OCR chỉ nhận diện tiêu đề; không đọc nội dung khám/xét nghiệm và không thay thế Gemini.
 */
export async function extractAndFilterPages(
  file: File,
  onProgress?: (processedPages: number, totalPages: number) => void
): Promise<ValidPage[][]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
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

    const processPage = async (pageNumber: number, ocrWorker: any): Promise<ValidPage | null> => {
      const page = await pdf.getPage(pageNumber);
      const displayCanvas = document.createElement("canvas");
      const aiCanvas = document.createElement("canvas");
      const headerCanvas = document.createElement("canvas");
      const sampleCanvas = document.createElement("canvas");

      try {
        const displayContext = displayCanvas.getContext("2d", { willReadFrequently: true });
        const aiContext = aiCanvas.getContext("2d", { willReadFrequently: true });
        const headerContext = headerCanvas.getContext("2d", { willReadFrequently: true });
        const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });

        if (!displayContext || !aiContext || !headerContext || !sampleContext) {
          throw new Error("Trình duyệt không thể khởi tạo canvas để đọc PDF.");
        }

        // Giữ nguyên độ phân giải và chất lượng ảnh hiển thị như phiên bản trước.
        const displayViewport = page.getViewport({ scale: 1.8 });
        displayCanvas.width = Math.ceil(displayViewport.width);
        displayCanvas.height = Math.ceil(displayViewport.height);
        displayContext.fillStyle = "#ffffff";
        displayContext.fillRect(0, 0, displayCanvas.width, displayCanvas.height);
        await page.render({ canvasContext: displayContext, viewport: displayViewport } as any).promise;

        if (!hasVisibleContent(
          displayContext,
          displayCanvas.width,
          displayCanvas.height,
          sampleCanvas,
          sampleContext
        )) return null;

        const displayBase64 = displayCanvas.toDataURL("image/jpeg", 0.82);

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
        try {
          const ocrResult = await ocrWorker.recognize(headerCanvas);
          headerText = ocrResult?.data?.text || "";
        } catch (ocrError) {
          // Giữ nguyên hành vi cũ: lỗi OCR một trang không làm hỏng toàn bộ PDF.
          console.warn(`Không OCR được vùng đầu trang ${pageNumber}:`, ocrError);
        }

        const documentMarker = classifyHeader(headerText);

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

        const base64 = aiCanvas.toDataURL("image/jpeg", 0.62);
        return { pageNumber, base64, displayBase64, documentMarker, headerText };
      } finally {
        page.cleanup();
        // Thu hồi bộ nhớ canvas ngay sau mỗi trang, kể cả khi OCR/render gặp lỗi.
        displayCanvas.width = 0;
        displayCanvas.height = 0;
        aiCanvas.width = 0;
        aiCanvas.height = 0;
        headerCanvas.width = 0;
        headerCanvas.height = 0;
        sampleCanvas.width = 0;
        sampleCanvas.height = 0;

        processedPages++;
        if (onProgress && (
          processedPages === 1 ||
          processedPages % 2 === 0 ||
          processedPages === pdf.numPages
        )) {
          onProgress(processedPages, pdf.numPages);
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
  } finally {
    await Promise.allSettled(ocrWorkers.map(worker => worker.terminate()));
    await pdf.cleanup();
  }

  return validPages.length > 0 ? [validPages] : [];
}
