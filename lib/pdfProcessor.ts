
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
  /** Văn bản OCR vùng đầu trang. */
  headerText?: string;
  /** Trang có dấu hiệu kết luận cuối cùng của phiếu khám sức khỏe. */
  patientEnd?: boolean;
  /** Trang thuộc phần phiếu xét nghiệm, không gửi Gemini. */
  isLabPage?: boolean;
  /** Có nét mực giống chữ ký ở vùng cuối trang. */
  hasSignature?: boolean;
  /** Có mực đỏ giống dấu mộc ở vùng cuối trang. */
  hasRedStamp?: boolean;
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
    if (pixels[i] < 245 || pixels[i + 1] < 245 || pixels[i + 2] < 245) {
      darkPixels++;
    }
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
  const words = normalized.split(" ").filter(Boolean);

  // OCR đầu trang đôi khi đọc sai/mất một vài ký tự hoặc ngắt cụm từ.
  // Dùng so khớp gần đúng cho các từ tiêu đề, nhưng vẫn yêu cầu đủ cụm
  // "GIAY KHAM" + "SUC KHOE" + dấu hiệu biểu mẫu người từ đủ 18 tuổi.
  const editDistance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const old = row[j];
        row[j] = Math.min(
          row[j] + 1,
          row[j - 1] + 1,
          previous + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        previous = old;
      }
    }
    return row[b.length];
  };

  const hasApproxWord = (target: string, maxDistance = 1): boolean =>
    words.some(word =>
      word.length >= target.length - maxDistance &&
      word.length <= target.length + maxDistance &&
      editDistance(word, target) <= maxDistance
    );

  const hasHealthTitle =
    normalized.includes("GIAY KHAM SUC KHOE") ||
    (hasApproxWord("GIAY") && hasApproxWord("KHAM") &&
      hasApproxWord("SUC") && hasApproxWord("KHOE"));

  const hasAdultPhrase =
    normalized.includes("DINH KY") ||
    normalized.includes("TU DU 18 TUOI") ||
    normalized.includes("NGUOI TU DU 18") ||
    (hasApproxWord("DINH") && hasApproxWord("KY")) ||
    (hasApproxWord("NGUOI") && hasApproxWord("TU") &&
      hasApproxWord("DU") && words.some(word => word === "18" || word === "I8"));

  if (hasHealthTitle && hasAdultPhrase) return "PATIENT_START";

  const hasLabTitle =
    normalized.includes("PHIEU KET QUA XET NGHIEM") ||
    (hasApproxWord("PHIEU") && hasApproxWord("KET") &&
      hasApproxWord("QUA") && hasApproxWord("XET") && hasApproxWord("NGHIEM"));

  if (hasLabTitle) return "LAB_START";
  return null;
}

/**
 * Nhận diện dấu hiệu chữ ký và dấu mộc đỏ bằng màu pixel ở vùng cuối trang.
 * Đây chỉ là thông tin hỗ trợ kiểm tra, KHÔNG dùng làm điều kiện kết thúc hồ sơ.
 */
function detectSignatureAndRedStamp(
  canvas: HTMLCanvasElement
): {
  hasSignature: boolean;
  hasRedStamp: boolean;
  redRatio: number;
  signatureRatio: number;
  redPixels: number;
  signatureInkPixels: number;
} {
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context || canvas.width < 2 || canvas.height < 2) {
    return {
      hasSignature: false,
      hasRedStamp: false,
      redRatio: 0,
      signatureRatio: 0,
      redPixels: 0,
      signatureInkPixels: 0
    };
  }

  const width = canvas.width;
  const height = canvas.height;
  const pixels = context.getImageData(0, 0, width, height).data;

  let redPixels = 0;
  let signatureInkPixels = 0;

  const signatureStartY = Math.floor(height * 0.18);
  const signatureEndY = Math.floor(height * 0.96);
  const signatureMinX = Math.floor(width * 0.04);
  const signatureMaxX = Math.floor(width * 0.97);

  const signatureAreaPixels =
    Math.max(1, signatureEndY - signatureStartY) *
    Math.max(1, signatureMaxX - signatureMinX);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const alpha = pixels[i + 3];

      if (alpha < 40) continue;

      const isRedInk =
        r > 105 &&
        r > g * 1.18 &&
        r > b * 1.12 &&
        g < 215 &&
        b < 215;

      if (isRedInk) redPixels++;

      if (
        y >= signatureStartY &&
        y <= signatureEndY &&
        x >= signatureMinX &&
        x <= signatureMaxX
      ) {
        const isDarkOrBlueInk =
          (r < 155 && g < 165 && b < 185) ||
          (b > r * 1.12 && b > g * 1.04 && b < 225);

        const isNotRed = !(r > g * 1.18 && r > b * 1.12);

        if (isDarkOrBlueInk && isNotRed) {
          signatureInkPixels++;
        }
      }
    }
  }

  const totalPixels = width * height;
  const redRatio = redPixels / Math.max(1, totalPixels);
  const signatureRatio = signatureInkPixels / signatureAreaPixels;

  return {
    hasRedStamp: redPixels >= 25 && redRatio >= 0.00006,
    hasSignature: signatureInkPixels >= 55 && signatureRatio >= 0.00045,
    redRatio,
    signatureRatio,
    redPixels,
    signatureInkPixels
  };
}

/**
 * Chỉ nhận diện trang kết luận khi có đủ dấu hiệu nội dung:
 * - Phân loại sức khỏe chung; và
 * - Kết luận hoặc thông tin bác sĩ/người khám.
 *
 * Không sử dụng chữ ký hoặc dấu mộc đỏ làm điều kiện kết thúc.
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

  return (
    (hasOverallClassification && (hasConclusion || hasDoctorSign)) ||
    (hasConclusion && hasDoctorSign)
  );
}

/**
 * Nhận diện trang xét nghiệm tiếp theo sau LAB_START bằng nội dung OCR.
 * Chỉ dùng các dấu hiệu tương đối đặc trưng; không dựa vào các từ chung
 * như "kết quả" hoặc "chỉ số" đơn lẻ để tránh loại nhầm trang khám.
 */
function classifyLabContent(footerText: string, headerText: string): boolean {
  const normalized = normalizeOcrText(`${headerText} ${footerText}`);

  if (normalized.includes("PHIEU KET QUA XET NGHIEM")) return true;

  const diagnosticGroups = [
    ["HUYET HOC", "CONG THUC MAU", "TE BAO MAU"],
    ["SINH HOA", "HOA SINH", "GLUCOSE", "URE", "CREATININ"],
    ["NUOC TIEU", "TONG PHAN TICH NUOC TIEU"],
    ["VI SINH", "VI KHUAN", "NUOI CAY"],
    ["MIEN DICH", "HORMON", "SEROLOGY"],
    ["TEN XET NGHIEM", "CHI SO XET NGHIEM", "KET QUA XET NGHIEM"]
  ];

  const matchedGroups = diagnosticGroups.filter(group =>
    group.some(term => normalized.includes(term))
  ).length;

  const hasReferenceColumn =
    normalized.includes("KHOANG THAM CHIEU") ||
    normalized.includes("TRI SO THAM CHIEU") ||
    normalized.includes("GIA TRI THAM CHIEU");

  return matchedGroups >= 2 || (matchedGroups >= 1 && hasReferenceColumn);
}

interface PatientPageSegment {
  start: number;
  end: number;
  labStart?: number;
}

/**
 * Chia các trang thành từng vùng hồ sơ dựa trên PATIENT_START.
 * LAB_START chỉ đánh dấu vị trí bắt đầu phần xét nghiệm, không kết thúc hồ sơ.
 */
function getPatientSegments(pages: ValidPage[]): PatientPageSegment[] {
  const starts = pages
    .map((page, index) => page.documentMarker === "PATIENT_START" ? index : -1)
    .filter(index => index >= 0);

  return starts.map((start, index) => {
    const end = (starts[index + 1] ?? pages.length) - 1;

    const labStart = pages.findIndex((page, pageIndex) =>
      pageIndex >= start &&
      pageIndex <= end &&
      page.documentMarker === "LAB_START"
    );

    return {
      start,
      end,
      labStart: labStart >= 0 ? labStart : undefined
    };
  });
}

/**
 * Đọc PDF scan:
 * - OCR đầu trang để tìm PATIENT_START và LAB_START.
 * - Chỉ OCR chân trang hồ sơ cuối, quét ngược đến khi tìm thấy patientEnd.
 * - Các hồ sơ trước kết thúc tại PATIENT_START kế tiếp, không cần OCR footer.
 * - LAB_START đánh dấu phần phụ lục; toàn bộ trang từ đó đến hồ sơ kế tiếp bị loại.
 *
 * Không giả định số trang cố định cho mỗi bệnh nhân.
 */
export async function extractAndFilterPages(
  file: File,
  onProgress?: (
    processedPages: number,
    totalPages: number,
    metrics?: PdfProcessingMetrics
  ) => void
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

  const logicalCores =
    typeof navigator !== "undefined" ? (navigator.hardwareConcurrency || 2) : 2;

  const desiredWorkerCount =
    pdf.numPages >= 20 && logicalCores >= 4 ? 2 : 1;

  try {
    const workerInitStartedAt = Date.now();
    const { createWorker } = await import("tesseract.js");

    for (let i = 0; i < desiredWorkerCount; i++) {
      let worker: any = null;

      try {
        worker = await createWorker("vie");
        await worker.setParameters({ tessedit_pageseg_mode: "6" });
        ocrWorkers.push(worker);
      } catch (workerError) {
        if (worker) {
          await worker.terminate().catch(() => undefined);
        }

        if (ocrWorkers.length === 0) {
          throw workerError;
        }

        console.warn(
          "Không khởi tạo được OCR worker bổ sung; tiếp tục bằng số worker hiện có.",
          workerError
        );
        break;
      }
    }

    metrics.workerInitMs = Date.now() - workerInitStartedAt;

    const processPage = async (
      pageNumber: number,
      ocrWorker: any
    ): Promise<ValidPage | null> => {
      const pageStartedAt = Date.now();
      const page = await pdf.getPage(pageNumber);

      const displayCanvas = document.createElement("canvas");
      const aiCanvas = document.createElement("canvas");
      const headerCanvas = document.createElement("canvas");
      const sampleCanvas = document.createElement("canvas");

      try {
        const displayContext = displayCanvas.getContext("2d", {
          willReadFrequently: true
        });
        const aiContext = aiCanvas.getContext("2d", {
          willReadFrequently: true
        });
        const headerContext = headerCanvas.getContext("2d", {
          willReadFrequently: true
        });
        const sampleContext = sampleCanvas.getContext("2d", {
          willReadFrequently: true
        });

        if (!displayContext || !aiContext || !headerContext || !sampleContext) {
          throw new Error("Trình duyệt không thể khởi tạo canvas để đọc PDF.");
        }

        // Ảnh hiển thị: giữ scale 1.8 và JPEG 0.82.
        const displayViewport = page.getViewport({ scale: 1.8 });

        displayCanvas.width = Math.ceil(displayViewport.width);
        displayCanvas.height = Math.ceil(displayViewport.height);

        displayContext.fillStyle = "#ffffff";
        displayContext.fillRect(0, 0, displayCanvas.width, displayCanvas.height);

        const renderStartedAt = Date.now();

        await page.render({
          canvasContext: displayContext,
          viewport: displayViewport
        } as any).promise;

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

        const displayEncodeStartedAt = Date.now();
        const displayBase64 = displayCanvas.toDataURL("image/jpeg", 0.82);
        metrics.imageEncodeMs += Date.now() - displayEncodeStartedAt;

        // OCR 34% đầu trang, chiều rộng tối đa 760px, PSM 6.
        const headerSourceHeight = Math.max(
          1,
          Math.floor(displayCanvas.height * 0.34)
        );

        const headerScale = Math.min(1, 760 / displayCanvas.width);

        headerCanvas.width = Math.max(
          1,
          Math.round(displayCanvas.width * headerScale)
        );

        headerCanvas.height = Math.max(
          1,
          Math.round(headerSourceHeight * headerScale)
        );

        headerContext.fillStyle = "#ffffff";
        headerContext.fillRect(0, 0, headerCanvas.width, headerCanvas.height);

        headerContext.drawImage(
          displayCanvas,
          0,
          0,
          displayCanvas.width,
          headerSourceHeight,
          0,
          0,
          headerCanvas.width,
          headerCanvas.height
        );

        let headerText = "";

        const headerOcrStartedAt = Date.now();

        try {
          const ocrResult = await ocrWorker.recognize(headerCanvas);
          metrics.headerOcrCalls++;
          headerText = ocrResult?.data?.text || "";
        } catch (ocrError) {
          console.warn(
            `Không OCR được vùng đầu trang ${pageNumber}:`,
            ocrError
          );
        } finally {
          metrics.headerOcrMs += Date.now() - headerOcrStartedAt;
        }

        const documentMarker = classifyHeader(headerText);

        // Ảnh AI: giữ scale 1.0 và JPEG 0.62.
        const aiViewport = page.getViewport({ scale: 1.0 });

        aiCanvas.width = Math.ceil(aiViewport.width);
        aiCanvas.height = Math.ceil(aiViewport.height);

        aiContext.fillStyle = "#ffffff";
        aiContext.fillRect(0, 0, aiCanvas.width, aiCanvas.height);

        aiContext.drawImage(
          displayCanvas,
          0,
          0,
          displayCanvas.width,
          displayCanvas.height,
          0,
          0,
          aiCanvas.width,
          aiCanvas.height
        );

        const aiEncodeStartedAt = Date.now();
        const base64 = aiCanvas.toDataURL("image/jpeg", 0.62);
        metrics.imageEncodeMs += Date.now() - aiEncodeStartedAt;

        return {
          pageNumber,
          base64,
          displayBase64,
          documentMarker,
          headerText,
          patientEnd: false,
          isLabPage: documentMarker === "LAB_START"
        };
      } finally {
        page.cleanup();

        displayCanvas.width = 0;
        displayCanvas.height = 0;
        aiCanvas.width = 0;
        aiCanvas.height = 0;
        headerCanvas.width = 0;
        headerCanvas.height = 0;
        sampleCanvas.width = 0;
        sampleCanvas.height = 0;

        processedPages++;
        metrics.pageProcessingMs += Date.now() - pageStartedAt;

        if (
          onProgress &&
          (
            processedPages === 1 ||
            processedPages % 2 === 0 ||
            processedPages === pdf.numPages
          )
        ) {
          onProgress(processedPages, pdf.numPages, {
            ...metrics,
            totalMs: Date.now() - totalStartedAt
          });
        }
      }
    };

    // Render/OCR đầu trang theo nhóm nhỏ, giữ nguyên thứ tự trang.
    const concurrency = Math.max(1, ocrWorkers.length);

    for (
      let firstPage = 1;
      firstPage <= pdf.numPages;
      firstPage += concurrency
    ) {
      const pageNumbers = Array.from(
        { length: Math.min(concurrency, pdf.numPages - firstPage + 1) },
        (_, offset) => firstPage + offset
      );

      const settled = await Promise.allSettled(
        pageNumbers.map((pageNumber, index) =>
          processPage(pageNumber, ocrWorkers[index])
        )
      );

      const failed = settled.find(
        (item): item is PromiseRejectedResult => item.status === "rejected"
      );

      if (failed) throw failed.reason;

      for (const item of settled) {
        if (item.status === "fulfilled" && item.value) {
          validPages.push(item.value);
        }
      }
    }

    /*
     * TỐI ƯU FOOTER OCR:
     * - Các hồ sơ trước: điểm kết thúc chính là trang ngay trước PATIENT_START
     *   kế tiếp, vì vậy không cần OCR footer các trang này.
     * - Chỉ hồ sơ cuối cùng không có PATIENT_START kế tiếp nên cần tìm patientEnd.
     * - Các hồ sơ trước kết thúc tại PATIENT_START kế tiếp; phần sau LAB_START bị loại.
     * - Quét hồ sơ cuối từ cuối PDF trở ngược và dừng ngay khi tìm thấy patientEnd.
     *
     * LAB_START là ranh giới giữa phiếu khám cần trích xuất và phần phụ lục.
     * Toàn bộ trang từ LAB_START đến trước PATIENT_START tiếp theo được loại.
     */
    const patientSegments = getPatientSegments(validPages);
    const finalSegment = patientSegments.length > 0
      ? patientSegments[patientSegments.length - 1]
      : undefined;

    // Theo yêu cầu nghiệp vụ: chỉ lấy phiếu khám sức khỏe đầu tiên đến
    // phần kết luận. Khi đã gặp LAB_START, toàn bộ phần còn lại của hồ sơ
    // là phụ lục/xét nghiệm đính kèm, không gửi Gemini (kể cả xét nghiệm
    // nối tiếp không lặp tiêu đề, siêu âm hoặc trang lưu trữ đi kèm).
    // PATIENT_START kế tiếp sẽ mở hồ sơ mới và kết thúc vùng loại bỏ này.
    for (const segment of patientSegments) {
      if (segment.labStart === undefined) continue;
      for (let index = segment.labStart; index <= segment.end; index++) {
        validPages[index].isLabPage = true;
      }
    }

    // Bảo đảm mọi trang có marker LAB_START đều bị loại, kể cả trường hợp
    // marker xuất hiện ở trang đầu của một segment hoặc OCR segment bất thường.
    for (const page of validPages) {
      if (page.documentMarker === "LAB_START") page.isLabPage = true;
    }

    const excludedAttachmentRanges = patientSegments
      .filter(segment => segment.labStart !== undefined)
      .map(segment => ({
        startPage: validPages[segment.labStart!].pageNumber,
        endPage: validPages[segment.end].pageNumber
      }));

    console.info("[KSK Segmentation]", {
      patientStartPages: validPages
        .filter(page => page.documentMarker === "PATIENT_START")
        .map(page => page.pageNumber),
      excludedAttachmentRanges
    });

    const footerTargetPages: ValidPage[] = finalSegment
      ? validPages
          .slice(finalSegment.start, finalSegment.end + 1)
          .reverse()
      : [];

    metrics.footerCandidatePages = footerTargetPages.length;

    const processFooter = async (
      validPage: ValidPage,
      ocrWorker: any
    ): Promise<void> => {
      const footerStartedAt = Date.now();
      const page = await pdf.getPage(validPage.pageNumber);

      const footerCanvas = document.createElement("canvas");
      const sourceCanvas = document.createElement("canvas");

      try {
        const footerContext = footerCanvas.getContext("2d", {
          willReadFrequently: true
        });

        const sourceContext = sourceCanvas.getContext("2d", {
          willReadFrequently: true
        });

        if (!footerContext || !sourceContext) {
          throw new Error("Trình duyệt không thể khởi tạo canvas OCR chân trang.");
        }

        // Giữ nguyên chất lượng render footer hiện tại để không ảnh hưởng
        // khả năng nhận diện chữ viết tay và thông tin kết luận.
        const viewport = page.getViewport({ scale: 1.8 });

        sourceCanvas.width = Math.ceil(viewport.width);
        sourceCanvas.height = Math.ceil(viewport.height);

        sourceContext.fillStyle = "#ffffff";
        sourceContext.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);

        const renderStartedAt = Date.now();

        await page.render({
          canvasContext: sourceContext,
          viewport
        } as any).promise;

        metrics.renderMs += Date.now() - renderStartedAt;

        // OCR vùng 35%-100% trang, chiều rộng tối đa 1000px.
        const footerSourceY = Math.floor(sourceCanvas.height * 0.35);
        const footerSourceHeight = Math.max(
          1,
          sourceCanvas.height - footerSourceY
        );

        const footerScale = Math.min(1, 1000 / sourceCanvas.width);

        footerCanvas.width = Math.max(
          1,
          Math.round(sourceCanvas.width * footerScale)
        );

        footerCanvas.height = Math.max(
          1,
          Math.round(footerSourceHeight * footerScale)
        );

        footerContext.fillStyle = "#ffffff";
        footerContext.fillRect(0, 0, footerCanvas.width, footerCanvas.height);

        footerContext.drawImage(
          sourceCanvas,
          0,
          footerSourceY,
          sourceCanvas.width,
          footerSourceHeight,
          0,
          0,
          footerCanvas.width,
          footerCanvas.height
        );

        // Chỉ lưu tín hiệu hình ảnh để tham khảo/debug.
        // Không dùng chữ ký hoặc dấu đỏ làm điều kiện kết thúc hồ sơ.
        const visualMarks = detectSignatureAndRedStamp(footerCanvas);

        validPage.hasSignature = visualMarks.hasSignature;
        validPage.hasRedStamp = visualMarks.hasRedStamp;

        const footerOcrStartedAt = Date.now();

        try {
          const footerResult = await ocrWorker.recognize(footerCanvas);

          metrics.footerOcrCalls++;

          const footerText = footerResult?.data?.text || "";
          const headerText = validPage.headerText || "";

          validPage.patientEnd = classifyPatientEnd(footerText, headerText);

          console.debug("[KSK Final Patient Detection]", {
            page: validPage.pageNumber,
            patientEnd: validPage.patientEnd,
            isLabPage: validPage.isLabPage,
            hasSignature: visualMarks.hasSignature,
            hasRedStamp: visualMarks.hasRedStamp
          });
        } catch (ocrError) {
          console.warn(
            `Không OCR được vùng cuối trang ${validPage.pageNumber}:`,
            ocrError
          );
        } finally {
          metrics.footerOcrMs += Date.now() - footerOcrStartedAt;
        }
      } finally {
        page.cleanup();

        sourceCanvas.width = 0;
        sourceCanvas.height = 0;
        footerCanvas.width = 0;
        footerCanvas.height = 0;

        metrics.pageProcessingMs += Date.now() - footerStartedAt;
      }
    };

    let footerProcessed = 0;
    let finalPatientEndFound = false;

    if (footerTargetPages.length > 0) {
      console.info(
        `[KSK Final Patient Detection] Bắt đầu quét ngược ${footerTargetPages.length} trang cuối hồ sơ.`
      );

      // Quét tuần tự từ trang cuối trở về đầu hồ sơ cuối.
      // Dùng một worker để có thể dừng chính xác ngay khi tìm thấy kết luận.
      const footerWorker = ocrWorkers[0];

      for (const validPage of footerTargetPages) {
        await processFooter(validPage, footerWorker);
        footerProcessed++;

        // patientEnd đầu tiên tìm thấy khi quét ngược chính là điểm kết thúc
        // cuối cùng của hồ sơ cuối. Không cần OCR các trang trước đó.
        if (validPage.patientEnd) {
          finalPatientEndFound = true;
          console.info(
            `[KSK Final Patient Detection] Đã tìm thấy điểm kết thúc tại trang PDF ${validPage.pageNumber}; dừng OCR footer.`
          );
          break;
        }
      }
    }

    console.info("[KSK Footer OCR Summary]", {
      finalPatientPages: footerTargetPages.length,
      footerPagesActuallyProcessed: footerProcessed,
      finalPatientEndFound,
      footerOcrCalls: metrics.footerOcrCalls
    });

    /*
     * Kết quả phân đoạn:
     * - Hồ sơ trung gian: kết thúc ngay trước PATIENT_START kế tiếp.
     * - Hồ sơ cuối: page.tsx sử dụng patientEnd để xác định điểm kết thúc.
     * - Chỉ hồ sơ cuối mới cần OCR footer; không OCR footer toàn bộ PDF.
     */

  } finally {
    await Promise.allSettled(
      ocrWorkers.map(worker => worker.terminate())
    );

    await pdf.cleanup();
  }

  metrics.validPages = validPages.length;
  metrics.totalMs = Date.now() - totalStartedAt;

  console.groupCollapsed("[KSK Performance] PDF processing");
  console.table(metrics);
  console.groupEnd();

  return validPages.length > 0 ? [validPages] : [];
}
