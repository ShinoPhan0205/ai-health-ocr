import { NextResponse } from "next/server";

// Cấu hình tăng Timeout cho Next.js / Vercel (cho phép chạy tối đa 60 giây)
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    // 1. NHẬN THÊM docType TỪ FRONTEND
    const { pages, modelId, docType = "ADULT_18", patientRanges } = await req.json();
    if (!Array.isArray(pages) || pages.length === 0 || pages.length > 15) {
      return NextResponse.json({ error: "Danh sách trang không hợp lệ (mỗi lô cần từ 1 đến 15 trang)." }, { status: 400 });
    }
    if (modelId !== "MODEL_1" && modelId !== "MODEL_2") {
      return NextResponse.json({ error: "modelId không hợp lệ." }, { status: 400 });
    }
    if (docType !== "ADULT_18" && docType !== "STUDENT") {
      return NextResponse.json({ error: "docType không được hỗ trợ." }, { status: 400 });
    }
    if (patientRanges !== undefined) {
      if (!Array.isArray(patientRanges) || patientRanges.length === 0) {
        return NextResponse.json({ error: "patientRanges không hợp lệ." }, { status: 400 });
      }
      for (const range of patientRanges) {
        const start = Number(range?.page_start);
        const end = Number(range?.page_end);
        const segmentIndex = Number(range?.segment_index);
        if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= pages.length) {
          return NextResponse.json({ error: "Khoảng trang bệnh nhân do OCR cung cấp không hợp lệ." }, { status: 400 });
        }
      }
    }
    for (const page of pages) {
      if (!page || typeof page.base64 !== "string" || !page.base64.includes(",")) {
        return NextResponse.json({ error: "Dữ liệu ảnh trang PDF không hợp lệ." }, { status: 400 });
      }
    }

    // Lựa chọn API Key và Model tương ứng (Giữ nguyên mô hình AI theo cấu hình của bạn)
    const isModel2 = modelId === "MODEL_2";
    const apiKey = isModel2 ? process.env.GEMINI_API_KEY_2 : process.env.GEMINI_API_KEY_1;
    const modelName = isModel2 ? "gemini-3.5-flash-lite" : "gemini-3.1-flash-lite";

    if (!apiKey) {
      return NextResponse.json(
        { error: `Chưa cấu hình ${isModel2 ? "GEMINI_API_KEY_2" : "GEMINI_API_KEY_1"} trong .env.local` },
        { status: 500 }
      );
    }

    const imageParts = pages.map((page: any) => ({
      inlineData: { mimeType: "image/jpeg", data: page.base64.split(",")[1] }
    }));

    // 2. CẤU HÌNH PROMPT VÀ JSON SCHEMA THEO TỪNG LOẠI HỒ SƠ
    let prompt = "";
    let responseSchema: any = null;

    if (docType === "STUDENT") {
      prompt = `Bạn là chuyên gia bóc tách hồ sơ y tế học sinh từ ảnh scan.
NHIỆM VỤ: xác định hồ sơ của từng học sinh trong đúng lô ảnh được cung cấp và trích xuất thông tin.
QUY TẮC PHÂN NHÓM BẮT BUỘC:
1. page_start và page_end là chỉ số ảnh trong lô hiện tại, bắt đầu từ 0; không dùng số trang in trên biểu mẫu.
2. Mỗi hồ sơ phải có khoảng trang liên tục nhỏ nhất thực sự thuộc về học sinh đó.
3. Không coi mỗi loại biểu mẫu/phiếu khám là một học sinh mới. Nhiều phiếu khác nhau có thể thuộc cùng một học sinh.
4. Chỉ gộp các trang khi có bằng chứng chúng thuộc cùng học sinh (mã định danh/CCCD, họ tên kết hợp ngày sinh, hoặc thông tin cá nhân nhất quán rõ ràng).
5. Không gộp hai học sinh chỉ vì trùng họ tên. Nếu không đọc được danh tính hoặc không chắc trang thuộc ai, không tự suy đoán danh tính; vẫn tạo hồ sơ riêng cho phần trang có thể xác định và để fullName rỗng nếu không đọc được.
6. Không tạo hai hồ sơ trùng nhau cho cùng một học sinh trong cùng lô. Không để các khoảng trang của hai học sinh khác nhau chồng lấn.
7. Không bỏ qua trang có dữ liệu. Trang trắng/không liên quan có thể bỏ qua.
8. Nếu một học sinh xuất hiện ở phần đầu và cuối lô nhưng giữa chúng có trang của người khác, không kéo dài khoảng trang qua người khác.
Nếu thông tin không có/không đọc được, dùng chuỗi rỗng. Chỉ trả về JSON theo schema.`;

      responseSchema = {
        type: "ARRAY",
        description: "Danh sách hồ sơ học sinh",
        items: {
          type: "OBJECT",
          properties: {
            page_start: { type: "INTEGER", description: "Trang bắt đầu của học sinh này (tính từ 0)" },
            page_end: { type: "INTEGER", description: "Trang kết thúc của học sinh này (tính từ 0)" },
            fullName: { type: "STRING", description: "Họ và tên" },
            dateOfBirth: { type: "STRING", description: "Ngày tháng năm sinh" },
            age: { type: "INTEGER", description: "Tuổi" },
            idNumber: { type: "STRING", description: "Số định danh / CCCD" },
            idIssueDate: { type: "STRING", description: "Ngày cấp" },
            idIssuePlace: { type: "STRING", description: "Nơi cấp" },
            phone: { type: "STRING", description: "Điện thoại" },
            addressDetail: { type: "STRING", description: "Số nhà/thôn/xóm/Địa chỉ" },
            schoolCode: { type: "STRING", description: "Mã cơ sở giáo dục" },
            facilityName: { type: "STRING", description: "Cơ sở kiểm tra sức khoẻ" },
            examinationDate: { type: "STRING", description: "Ngày khám" },
            height: { type: "NUMBER", description: "Chiều cao (cm)" },
            weight: { type: "NUMBER", description: "Cân nặng (kg)" },
            bmi: { type: "STRING", description: "Chỉ số BMI" },
            pulse: { type: "INTEGER", description: "Mạch" },
            bloodPressure: { type: "STRING", description: "Huyết áp" },
            eyeOtherDiseases: { type: "STRING", description: "Khám Mắt - Bệnh khác" },
            entOtherDiseases: { type: "STRING", description: "Khám Tai Mũi Họng - Bệnh khác" },
            upperJawExamination: { type: "STRING", description: "RHM - Hàm trên" },
            lowerJawExamination: { type: "STRING", description: "RHM - Hàm dưới" },
            dentalOtherDiseases: { type: "STRING", description: "RHM - Bệnh khác" },
            prolongedSadnessAnxietyInsomniaNote: { type: "STRING", description: "Sự buồn bã, lo âu kéo dài, mất ngủ" },
            abnormalBehaviorSelfHarmRiskNote: { type: "STRING", description: "Hành vi bất thường, tự hủy hoại bản thân" },
            healthIssuesNote: { type: "STRING", description: "Kết luận - Các vấn đề sức khỏe" },
            referToFacilityDetail: { type: "STRING", description: "Chuyển tuyến cơ sở KBCB" }
          },
          required: ["page_start", "page_end", "fullName"]
        }
      };
    } else {
      prompt = Array.isArray(patientRanges)
        ? `Bạn là chuyên gia trích xuất dữ liệu hồ sơ khám sức khỏe người lớn từ ảnh scan.
RANH GIỚI BỆNH NHÂN ĐÃ ĐƯỢC OCR VÀ THUẬT TOÁN XÁC ĐỊNH TRƯỚC. KHÔNG ĐƯỢC TỰ CHIA LẠI, GỘP, TÁCH, ĐỔI THỨ TỰ HOẶC SUY ĐOÁN RANH GIỚI.
Các khoảng trang dưới đây là CHÍNH XÁC và tính theo chỉ số ảnh trong request, bắt đầu từ 0:
${JSON.stringify(patientRanges)}
YÊU CẦU TRÍCH XUẤT VÀ ĐỌC KHÁM LÂM SÀNG:
1. Trả về đúng một object cho MỖI segment_index được cung cấp, theo đúng thứ tự danh sách.
2. segment_index phải được sao chép nguyên vẹn; page_start/page_end phải giữ đúng khoảng OCR cung cấp.
3. Chỉ đọc trang thuộc đúng segment. Không lấy dữ liệu của bệnh nhân khác.
4. Hai model hoạt động độc lập, tự đọc ảnh gốc; không giả định hoặc sao chép kết quả của model còn lại.
5. Đọc lần lượt TẤT CẢ các trang trong segment. Không bỏ qua phần khám lâm sàng, dấu mộc, chữ viết tay, dấu tick, số phân loại hoặc kết luận nằm ở cuối trang.
6. Không để trống trường nếu trên ảnh có nội dung đọc được. Nếu thực sự không có nội dung hoặc không thể đọc sau khi đã xem kỹ thì mới trả chuỗi rỗng. Không tự bịa dữ liệu.
7. Không dùng họ tên làm căn cứ thay đổi ranh giới.
8. Đọc đầy đủ các câu hỏi tiền sử gia đình và tiền sử bản thân TSGD_* và TSBT_*. Với Có/Không, đọc dấu đánh dấu thực tế. Nếu biểu mẫu quy định mặc định là Không và không có dấu xác nhận Có thì dùng Không; nếu không xác định được dấu thì để trống.
9. ĐỌC DẤU MỘC VÀ KẾT LUẬN THEO TỪNG CHUYÊN KHOA: phân biệt câu đóng dấu/in sẵn “HIỆN TẠI CHƯA PHÁT HIỆN BẤT THƯỜNG” với phần bác sĩ ghi thêm bằng tay hoặc đánh dấu khác. Nếu chỉ có dấu bình thường và không có kết luận bất thường bổ sung, ghi kết quả là “Hiện tại chưa phát hiện bất thường” và phân loại 1. Nếu có bất kỳ kết luận cụ thể nào khác dấu mộc (ví dụ tật khúc xạ, mất răng, tổn thương hoặc bệnh lý), phải ghi nhận kết luận đó; không được bỏ qua để giữ câu dấu mộc, cũng không tự động gán phân loại 1.
10. Với từng chuyên khoa, đọc số phân loại đúng ở ô/cột phân loại tương ứng của chính chuyên khoa đó (mã 1–5). Không lấy phân loại của chuyên khoa khác hoặc một số 1 đóng sẵn ở vị trí khác. Nếu có kết luận bất thường nhưng không đọc chắc được số phân loại thì để trống phân loại, không đoán.
11. PHÂN LOẠI SỨC KHỎE CHUNG: đọc dấu/kết luận chung và số phân loại chung trên biểu mẫu. Chỉ đặt phân loại 1 khi kết luận chung thực sự chỉ là bình thường/chưa phát hiện bất thường và không có phát hiện cụ thể bổ sung. Nếu có phát hiện cụ thể thì phải đọc phân loại chung thực tế; không tự gán 1.
12. GIẢI NGHĨA CHỮ VIẾT TẮT THEO NGỮ CẢNH Y KHOA VÀ CHUYÊN KHOA. Không chép máy móc chữ viết tắt nếu ý nghĩa rõ ràng. Ví dụ trong mục Răng-Hàm-Mặt, “Mất R36, R46” phải chuẩn hóa thành “Mất răng 36, răng 46”; R36/R46 là ký hiệu răng theo sơ đồ nha khoa, tuyệt đối không phải bệnh về mắt. Không đưa mã răng Rxx hoặc nội dung mất răng vào BENH_KHAC_MAT/KHAM_MAT_PL. Các nội dung về mắt như tật khúc xạ phải nằm ở BENH_KHAC_MAT; nội dung răng-hàm-mặt phải nằm ở HAM_TREN, HAM_DUOI hoặc BENH_KHAC_RANG_HAM_MAT tùy vị trí ghi trên biểu mẫu.
13. Khi chuẩn hóa chữ viết tắt, phải giữ nguyên ý nghĩa lâm sàng, vị trí giải phẫu, bên trái/phải và mã răng. Chỉ khai triển khi ngữ cảnh đủ rõ; không tự suy diễn chẩn đoán hoặc thêm bệnh không có trên ảnh.
14. Bốn trường thính lực TAI_TRAI_NOI_THUONG, TAI_PHAI_NOI_THUONG, TAI_TRAI_NOI_THAM, TAI_PHAI_NOI_THAM sẽ do hệ thống áp dụng mặc định sau trích xuất; không tự suy đoán các giá trị này từ số OCR nhầm.
15. Chỉ điền MA_CSKCB, MA_GTIN_CSKCB, NGAY_VAO khi đọc được từ hồ sơ.
Chỉ trả về JSON theo schema, không kèm giải thích.`
        : `Bạn là chuyên gia đọc hồ sơ khám sức khỏe người lớn từ ảnh scan.
NHIỆM VỤ: đọc các ảnh trong lô và nhóm các trang thuộc cùng một bệnh nhân, sau đó trích xuất thông tin.
QUY TẮC: page_start/page_end là chỉ số ảnh trong lô từ 0; không dùng số trang in trên biểu mẫu; không gộp chỉ vì trùng họ tên; không bịa dữ liệu; trả về JSON đúng schema.`;

      // Thêm responseSchema cho ADULT_18 để Gemini ép khung JSON chuẩn 100%, chống lỗi gãy mảng hoặc mất dữ liệu ở người cuối
      responseSchema = {
        type: "ARRAY",
        description: "Danh sách hồ sơ khám sức khỏe người lớn",
        items: {
          type: "OBJECT",
          properties: {
            segment_index: { type: "INTEGER", description: "Mã segment OCR cung cấp; phải giữ nguyên" },
            page_start: { type: "INTEGER", description: "Trang bắt đầu (tính từ 0)" },
            page_end: { type: "INTEGER", description: "Trang kết thúc (tính từ 0)" },
            MA_CSKCB: { type: "STRING", description: "Mã cơ sở khám bệnh, chữa bệnh gồm 05 ký tự nếu có trên hồ sơ" },
            MA_GTIN_CSKCB: { type: "STRING", description: "Mã cơ sở khám bệnh, chữa bệnh theo chuẩn GLN gồm 13 ký tự nếu có trên hồ sơ" },
            NGAY_VAO: { type: "STRING", description: "Ngày khám sức khỏe, định dạng DD/MM/YYYY nếu đọc được" },
            HO_TEN: { type: "STRING", description: "Họ và tên viết hoa" },
            GIOI_TINH: { type: "STRING", description: "Nam hoặc Nữ" },
            NGAY_SINH: { type: "STRING", description: "DD/MM/YYYY" },
            MA_DAN_TOC: { type: "STRING", description: "Mặc định Kinh" },
            SO_CCCD: { type: "STRING" },
            NGAYCAP_CCCD: { type: "STRING" },
            NOICAP_CCCD: { type: "STRING" },
            DIA_CHI: { type: "STRING" },
            NOI_LAM_VIEC_HOC_TAP: { type: "STRING" },
            DIEN_THOAI: { type: "STRING" },
            NHOM_MAU: { type: "STRING" },
            CHIEU_CAO: { type: "STRING" },
            CAN_NANG: { type: "STRING" },
            CHI_SO_BMI: { type: "STRING" },
            MACH: { type: "STRING" },
            HUYET_AP: { type: "STRING" },
            KHAM_THE_LUC_PL: { type: "STRING", description: "1-5" },
            NOI_KHOA_TUAN_HOAN: { type: "STRING", description: "Kết luận nội khoa chuyên khoa tuần hoàn; đọc cả dấu mộc và ghi chú bác sĩ." },
            NOI_KHOA_TUAN_HOAN_PL: { type: "STRING", description: "Phân loại tuần hoàn 1-5 theo dấu/ô đánh dấu của bác sĩ." },
            NOI_KHOA_HO_HAP: { type: "STRING", description: "Kết luận nội khoa hô hấp; đọc cả dấu mộc và ghi chú bác sĩ." },
            NOI_KHOA_HO_HAP_PL: { type: "STRING", description: "Phân loại hô hấp 1-5 theo dấu/ô đánh dấu của bác sĩ." },
            NOI_KHOA_TIEU_HOA: { type: "STRING", description: "Kết luận nội khoa tiêu hóa; đọc cả dấu mộc và ghi chú bác sĩ." },
            NOI_KHOA_TIEU_HOA_PL: { type: "STRING", description: "Phân loại tiêu hóa 1-5 theo dấu/ô đánh dấu của bác sĩ." },
            NOI_KHOA_THAN_TN_SD: { type: "STRING" },
            NOI_KHOA_THAN_TIETNIEU_PL: { type: "STRING" },
            NOI_KHOA_NOI_TIET: { type: "STRING" },
            NOI_KHOA_NOI_TIET_PL: { type: "STRING" },
            NOI_KHOA_CO_XUONG_KHOP: { type: "STRING" },
            NOI_KHOA_CO_XUONG_KHOP_PL: { type: "STRING" },
            NOI_KHOA_THAN_KINH: { type: "STRING" },
            NOI_KHOA_THAN_KINH_PL: { type: "STRING" },
            NOI_KHOA_TAM_THAN: { type: "STRING" },
            NOI_KHOA_TAM_THAN_PL: { type: "STRING" },
            KET_QUA_KHAM_NGOAI_KHOA: { type: "STRING", description: "Kết luận khám ngoại khoa; phải đọc dấu mộc và mọi kết luận viết tay bổ sung." },
            KHAM_NGOAI_KHOA_PL: { type: "STRING", description: "Phân loại ngoại khoa 1-5 theo ô bác sĩ đánh dấu." },
            KET_QUA_KHAM_DA_LIEU: { type: "STRING", description: "Kết luận khám da liễu; đọc dấu mộc và ghi chú bất thường viết tay." },
            KHAM_DA_LIEU_PL: { type: "STRING", description: "Phân loại da liễu 1-5 theo ô bác sĩ đánh dấu." },
            KHONG_KINH_MAT_PHAI: { type: "STRING" },
            KHONG_KINH_MAT_TRAI: { type: "STRING" },
            CO_KINH_MAT_PHAI: { type: "STRING" },
            CO_KINH_MAT_TRAI: { type: "STRING" },
            BENH_KHAC_MAT: { type: "STRING", description: "Chỉ ghi bệnh/kết luận thuộc chuyên khoa Mắt, ví dụ tật khúc xạ. Không ghi mất răng hoặc mã răng Rxx." },
            KHAM_MAT_PL: { type: "STRING", description: "Phân loại khám Mắt 1-5, đọc đúng ô phân loại của chuyên khoa Mắt." },
            TAI_TRAI_NOI_THUONG: { type: "STRING" },
            TAI_PHAI_NOI_THUONG: { type: "STRING" },
            TAI_TRAI_NOI_THAM: { type: "STRING" },
            TAI_PHAI_NOI_THAM: { type: "STRING" },
            BENH_KHAC_TAI_MUI_HONG: { type: "STRING" },
            KHAM_TAI_MUI_HONG_PL: { type: "STRING" },
            HAM_TREN: { type: "STRING", description: "Kết quả khám hàm trên thuộc chuyên khoa Răng-Hàm-Mặt." },
            HAM_DUOI: { type: "STRING", description: "Kết quả khám hàm dưới thuộc chuyên khoa Răng-Hàm-Mặt." },
            BENH_KHAC_RANG_HAM_MAT: { type: "STRING", description: "Bệnh/kết luận khác thuộc Răng-Hàm-Mặt. Mã R36, R46 là mã răng, phải ghi thành Mất răng 36, răng 46; tuyệt đối không chuyển sang Mắt." },
            KHAM_RANG_HAM_MAT_PL: { type: "STRING", description: "Phân loại khám Răng-Hàm-Mặt 1-5, đọc đúng ô phân loại của chuyên khoa này." },
            PHAN_LOAI_SK: { type: "STRING", description: "Phân loại sức khỏe chung 1-5 theo kết luận và dấu/ô bác sĩ đánh dấu; không mặc định 1 nếu có phát hiện cụ thể." },
            KET_LUAN_BENH: { type: "STRING", description: "Kết luận chung; đọc cả dấu mộc bình thường và mọi kết luận cụ thể/viết tay bổ sung. Không bỏ mất phát hiện bất thường nằm cạnh dấu mộc." },
            CAC_BENH_TAT_NEU_CO: { type: "STRING", description: "Các bệnh/tật được ghi cụ thể; chuẩn hóa viết tắt theo đúng ngữ cảnh, giữ nguyên ý nghĩa y khoa." },

            // Tiền sử gia đình và tiền sử bản thân theo đúng biểu mẫu Excel.
            TSGD_MAC_BENH: { type: "STRING", description: "Gia đình có ai mắc các bệnh được liệt kê không; Có/Không" },
            TSGD_MA_BENH: { type: "STRING", description: "Tên bệnh của người thân trong gia đình nếu có" },
            TSBT_BENH_TRONG_5_NAM_QUA: { type: "STRING", description: "Có bệnh hay bị thương trong 5 năm qua; Có/Không" },
            TSBT_BENH_THAN_KINH: { type: "STRING", description: "Có bệnh thần kinh hay bị thương ở đầu; Có/Không" },
            TSBT_BENH_MAT: { type: "STRING", description: "Có bệnh mắt hoặc giảm thị lực (trừ đeo kính thuốc); Có/Không" },
            TSBT_BENH_TAI: { type: "STRING", description: "Có bệnh ở tai, giảm sức nghe hoặc thăng bằng; Có/Không" },
            TSBT_BENH_TIM: { type: "STRING", description: "Có bệnh ở tim, nhồi máu cơ tim hoặc bệnh tim mạch khác; Có/Không" },
            TSBT_PHAU_THUAT_TIM: { type: "STRING", description: "Đã phẫu thuật can thiệp tim-mạch; Có/Không" },
            TSBT_TANG_HUYET_AP: { type: "STRING", description: "Có tăng huyết áp; Có/Không" },
            TSBT_KHO_THO: { type: "STRING", description: "Có khó thở; Có/Không" },
            TSBT_BENH_PHOI: { type: "STRING", description: "Có bệnh phổi, hen, khí phế thũng hoặc viêm phế quản mạn tính; Có/Không" },
            TSBT_BENH_THAN: { type: "STRING", description: "Có bệnh thận hoặc lọc máu; Có/Không" },
            TSBT_NGHIEN_RUOU: { type: "STRING", description: "Có nghiện rượu, bia; Có/Không" },
            TSBT_DAI_THAO_DUONG: { type: "STRING", description: "Có đái tháo đường hoặc kiểm soát tăng đường huyết; Có/Không" },
            TSBT_BENH_TAM_THAN: { type: "STRING", description: "Có bệnh tâm thần; Có/Không" },
            TSBT_MAT_Y_THUC: { type: "STRING", description: "Có mất ý thức hoặc rối loạn ý thức; Có/Không" },
            TSBT_NGAT: { type: "STRING", description: "Có ngất hoặc chóng mặt; Có/Không" },
            TSBT_BENH_TIEU_HOA: { type: "STRING", description: "Có bệnh tiêu hóa; Có/Không" },
            TSBT_ROI_LOAN_GIAC_NGU: { type: "STRING", description: "Có rối loạn giấc ngủ, ngừng thở khi ngủ, ngủ rũ hoặc ngáy to; Có/Không" },
            TSBT_TAI_BIEN: { type: "STRING", description: "Có tai biến mạch máu não hoặc liệt; Có/Không" },
            TSBT_BENH_COT_SONG: { type: "STRING", description: "Có bệnh hoặc tổn thương cột sống; Có/Không" },
            TSBT_RUOU_THUONG_XUYEN: { type: "STRING", description: "Có sử dụng rượu thường xuyên, liên tục; Có/Không" },
            TSBT_MA_TUY: { type: "STRING", description: "Có sử dụng ma túy hoặc chất gây nghiện; Có/Không" },
            TSBT_BENH_KHAC: { type: "STRING", description: "Có bệnh khác; Có/Không" },
            TSBT_MA_BENH_KHAC: { type: "STRING", description: "Tên bệnh khác theo ICD-10 nếu có" },
            TSBT_DANG_DIEU_TRI_BENH: { type: "STRING", description: "Hiện tại có đang điều trị bệnh gì không; Có/Không" },
            TSBT_MA_BENH: { type: "STRING", description: "Tên bệnh tiền sử bản thân theo ICD-10 nếu có" },
            TSBT_TEN_THUOC_LIEU_LUONG: { type: "STRING", description: "Thuốc đang sử dụng và liều lượng" },
            TSBT_THAI_SAN: { type: "STRING", description: "Tiền sử thai sản; Có/Không hoặc nội dung ghi trên biểu mẫu" },
            TSBT_MA_BENH_THAI_SAN: { type: "STRING", description: "Tên bệnh thai sản theo ICD-10 nếu có" },
            TSBT_TEN_THUOC_THAI_SAN: { type: "STRING", description: "Thuốc đang sử dụng điều trị bệnh thai sản" },
            KET_QUA_KHAM_SAN_PHU_KHOA: { type: "STRING", description: "Kết quả khám sản phụ khoa" },
            KHAM_SAN_PHU_KHOA_PL: { type: "STRING", description: "Phân loại kết quả khám sản phụ khoa, mã 1-5" }
          },
          required: patientRanges ? ["segment_index", "page_start", "page_end", "HO_TEN"] : ["page_start", "page_end", "HO_TEN"]
        }
      };
    }

    // 3. GỌI API GEMINI
    const requestBody: any = {
      contents: [{ parts: [{ text: prompt }, ...imageParts] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: responseSchema
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const textResult = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textResult) throw new Error("AI không trả về kết quả hợp lệ.");

    const cleanJsonText = textResult.replace(/```json/g, "").replace(/```/g, "").trim();
    const rawPatients = JSON.parse(cleanJsonText);

    if (!Array.isArray(rawPatients)) throw new Error("AI trả về dữ liệu không phải mảng hồ sơ.");

    // Kiểm tra và giới hạn khoảng trang theo đúng kích thước lô.
    const validatedPatients = rawPatients.flatMap((patient: any) => {
      if (docType === "ADULT_18" && Array.isArray(patientRanges)) {
        const segmentIndex = Number(patient?.segment_index);
        const trustedRange = patientRanges.find((range: any) => Number(range.segment_index) === segmentIndex);
        if (!trustedRange) return [];
        return [{
          ...patient,
          segment_index: segmentIndex,
          page_start: Number(trustedRange.page_start),
          page_end: Number(trustedRange.page_end)
        }];
      }
      const start = Number(patient?.page_start);
      const end = Number(patient?.page_end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= pages.length) return [];
      return [{ ...patient, page_start: start, page_end: Math.min(end, pages.length - 1) }];
    });

    let cleanedPatients = validatedPatients;

    // 4. CHUẨN HÓA DỮ LIỆU CHO ADULT_18
    if (docType === "ADULT_18") {
      const normalizeForRules = (value: any) => String(value ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      // Chỉ coi là bình thường khi nội dung sau khi bỏ cụm dấu mộc bình thường
      // không còn kết luận cụ thể nào khác. Ví dụ “...; mất răng 36” KHÔNG bình thường.
      const isClearlyNormal = (value: any) => {
        let text = normalizeForRules(value);
        if (!text || text.includes("khong binh thuong")) return false;
        const normalPhrases = [
          "hien tai chua phat hien bat thuong",
          "chua phat hien bat thuong",
          "khong phat hien bat thuong",
          "khong ghi nhan bat thuong",
          "khong co bat thuong",
          "khong thay bat thuong",
          "hien tai binh thuong",
          "binh thuong",
          "bt"
        ];
        for (const phrase of normalPhrases) {
          text = text.replace(new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`, "g"), " ");
        }
        // Bỏ một số từ nối vô nghĩa còn lại sau khi loại dấu mộc.
        text = text.replace(/\b(hien tai|tai thoi diem kham|ket luan|dau moc|va|hoac|khong co gi khac)\b/g, " ")
          .replace(/\s+/g, " ").trim();
        return text.length === 0;
      };

      const isNegativeOnly = (value: any) => {
        const text = normalizeForRules(value);
        if (!text || text.includes("khong binh thuong")) return false;
        return /^(khong|chua|khong co|khong thay|khong ghi nhan|khong phat hien)(\s|$)/.test(text);
      };

      const normalizeClassification = (value: any) => {
        const raw = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
        // Giữ cả các ký hiệu vạch mà OCR đôi khi đọc thay cho số La Mã.
        if (["1", "I", "|"].includes(raw)) return "1";
        if (["2", "II", "11", "||"].includes(raw)) return "2";
        if (["3", "III", "111", "|||"].includes(raw)) return "3";
        if (["4", "IV", "1V", "14"].includes(raw)) return "4";
        if (["5", "V", "15"].includes(raw)) return "5";
        return String(value ?? "").trim();
      };

      const historyNoDefaults = [
        "TSGD_MAC_BENH",
        "TSBT_BENH_TRONG_5_NAM_QUA",
        "TSBT_BENH_THAN_KINH",
        "TSBT_BENH_MAT",
        "TSBT_BENH_TAI",
        "TSBT_BENH_TIM",
        "TSBT_PHAU_THUAT_TIM",
        "TSBT_TANG_HUYET_AP",
        "TSBT_KHO_THO",
        "TSBT_BENH_PHOI",
        "TSBT_BENH_THAN",
        "TSBT_NGHIEN_RUOU",
        "TSBT_DAI_THAO_DUONG",
        "TSBT_BENH_TAM_THAN",
        "TSBT_MAT_Y_THUC",
        "TSBT_NGAT",
        "TSBT_BENH_TIEU_HOA",
        "TSBT_ROI_LOAN_GIAC_NGU",
        "TSBT_TAI_BIEN",
        "TSBT_BENH_COT_SONG",
        "TSBT_RUOU_THUONG_XUYEN",
        "TSBT_MA_TUY",
        "TSBT_BENH_KHAC",
        "TSBT_DANG_DIEU_TRI_BENH",
        "TSBT_THAI_SAN"
      ];

      const clinicalPairs: Array<[string, string]> = [
        ["NOI_KHOA_TUAN_HOAN", "NOI_KHOA_TUAN_HOAN_PL"],
        ["NOI_KHOA_HO_HAP", "NOI_KHOA_HO_HAP_PL"],
        ["NOI_KHOA_TIEU_HOA", "NOI_KHOA_TIEU_HOA_PL"],
        ["NOI_KHOA_THAN_TN_SD", "NOI_KHOA_THAN_TIETNIEU_PL"],
        ["NOI_KHOA_NOI_TIET", "NOI_KHOA_NOI_TIET_PL"],
        ["NOI_KHOA_CO_XUONG_KHOP", "NOI_KHOA_CO_XUONG_KHOP_PL"],
        ["NOI_KHOA_THAN_KINH", "NOI_KHOA_THAN_KINH_PL"],
        ["NOI_KHOA_TAM_THAN", "NOI_KHOA_TAM_THAN_PL"],
        ["KET_QUA_KHAM_NGOAI_KHOA", "KHAM_NGOAI_KHOA_PL"],
        ["KET_QUA_KHAM_DA_LIEU", "KHAM_DA_LIEU_PL"],
        ["KET_QUA_KHAM_SAN_PHU_KHOA", "KHAM_SAN_PHU_KHOA_PL"],
        ["BENH_KHAC_MAT", "KHAM_MAT_PL"],
        ["BENH_KHAC_TAI_MUI_HONG", "KHAM_TAI_MUI_HONG_PL"]
      ];

      cleanedPatients = validatedPatients.map((patient: any) => {
        const p = { ...patient };

        // Bốn trường thính lực là giá trị mặc định cố định theo yêu cầu của biểu mẫu.
        // Ghi đè cả khi Gemini đọc nhầm thành 15/10 hoặc một giá trị khác.
        p["TAI_PHAI_NOI_THUONG"] = "5";
        p["TAI_TRAI_NOI_THUONG"] = "5";
        p["TAI_PHAI_NOI_THAM"] = "0.5";
        p["TAI_TRAI_NOI_THAM"] = "0.5";

        // Chuẩn hóa mã răng FDI trong các trường Răng-Hàm-Mặt.
        // Ví dụ “Mắt R36, R46” do OCR nhầm dấu thành “Mất răng 36, răng 46”.
        const extractToothCodes = (value: any): string[] => {
          const text = String(value ?? "");
          const codeMatches = Array.from(text.matchAll(/\bR\s*([1-4][1-8])\b/gi), match => match[1]);
          const spelledMatches = Array.from(text.matchAll(/\brăng\s*([1-4][1-8])\b/gi), match => match[1]);
          return Array.from(new Set([...codeMatches, ...spelledMatches]));
        };
        const formatMissingTeeth = (codes: string[]) =>
          codes.length ? `Mất răng ${codes.join(", răng ")}` : "";
        const canonicalizeDentalText = (value: any) => {
          const text = String(value ?? "").trim();
          const codes = extractToothCodes(text);
          if (!codes.length) return text;
          return formatMissingTeeth(codes);
        };
        ["HAM_TREN", "HAM_DUOI", "BENH_KHAC_RANG_HAM_MAT"].forEach(key => {
          p[key] = canonicalizeDentalText(p[key]);
        });

        // Nếu Gemini đưa mã răng Rxx nhầm sang trường Mắt, chuyển nội dung răng
        // về Răng-Hàm-Mặt và không để lại chẩn đoán răng trong chuyên khoa Mắt.
        const eyeFinding = String(p["BENH_KHAC_MAT"] ?? "").trim();
        const eyeToothCodes = extractToothCodes(eyeFinding);
        if (eyeToothCodes.length) {
          const withoutDentalPart = eyeFinding
            .replace(/(?:mắt|mất)?\s*R\s*[1-4][1-8](?:\s*(?:(?:,|;|và|&|\/)\s*)?R\s*[1-4][1-8])*/gi, " ")
            .replace(/(?:mất\s*)?răng\s*[1-4][1-8](?:\s*(?:(?:,|;|và|&|\/)\s*)?(?:răng\s*)?[1-4][1-8])*/gi, " ")
            .replace(/\s+/g, " ").replace(/^[,;\s]+|[,;\s]+$/g, "").trim();
          p["BENH_KHAC_MAT"] = withoutDentalPart;
          const dentalText = String(p["BENH_KHAC_RANG_HAM_MAT"] ?? "").trim();
          const existingCodes = extractToothCodes(dentalText);
          const mergedCodes = Array.from(new Set([...existingCodes, ...eyeToothCodes]));
          p["BENH_KHAC_RANG_HAM_MAT"] = formatMissingTeeth(mergedCodes) || canonicalizeDentalText(dentalText);
        }

        // Giữ các mặc định "Không" của mẫu cho câu hỏi tiền sử Có/Không.
        historyNoDefaults.forEach(key => {
          if (p[key] === undefined || p[key] === null || String(p[key]).trim() === "") p[key] = "Không";
        });

        clinicalPairs.forEach(([descKey, plKey]) => {
          const description = p[descKey];
          const descriptionText = normalizeForRules(description);
          const existingClass = normalizeClassification(p[plKey]);

          // Chỉ tự gán loại 1 khi thực sự đọc thấy dấu/kết luận bình thường.
          // Trường trống không đồng nghĩa bình thường; kết luận bất thường phải
          // giữ phân loại bác sĩ đã đánh dấu, nếu chưa đọc được thì để trống.
          if (isClearlyNormal(description)) {
            p[plKey] = "1";
          } else if (existingClass) {
            p[plKey] = existingClass;
          } else if (descriptionText) {
            p[plKey] = "";
          }
        });

        // Phân loại Răng-Hàm-Mặt phải xét đồng thời hàm trên, hàm dưới và bệnh khác.
        // Không được tự gán loại 1 nếu một trong các vị trí có phát hiện như mất răng.
        const dentalDescriptions = ["HAM_TREN", "HAM_DUOI", "BENH_KHAC_RANG_HAM_MAT"]
          .map(key => String(p[key] ?? "").trim()).filter(Boolean);
        const dentalHasAbnormalFinding = dentalDescriptions.some(value =>
          !isClearlyNormal(value) && !isNegativeOnly(value)
        );
        const dentalClass = normalizeClassification(p["KHAM_RANG_HAM_MAT_PL"]);
        if (dentalHasAbnormalFinding) {
          // Chỉ giữ phân loại bác sĩ/model đã đọc; không tự suy đoán cấp độ bệnh.
          p["KHAM_RANG_HAM_MAT_PL"] = dentalClass;
        } else if (dentalDescriptions.some(isClearlyNormal)) {
          p["KHAM_RANG_HAM_MAT_PL"] = "1";
        } else if (dentalClass) {
          p["KHAM_RANG_HAM_MAT_PL"] = dentalClass;
        }

        if (!p["KHAM_THE_LUC_PL"] || String(p["KHAM_THE_LUC_PL"]).trim() === "") {
          p["KHAM_THE_LUC_PL"] = "1";
        } else {
          p["KHAM_THE_LUC_PL"] = normalizeClassification(p["KHAM_THE_LUC_PL"]);
        }

        // Phân loại sức khỏe chung: chỉ tự đặt 1 khi kết luận chung là bình thường
        // và không có phát hiện cụ thể ở bất kỳ chuyên khoa nào.
        const abnormalFindingKeys = [
          "NOI_KHOA_TUAN_HOAN", "NOI_KHOA_HO_HAP", "NOI_KHOA_TIEU_HOA",
          "NOI_KHOA_THAN_TN_SD", "NOI_KHOA_NOI_TIET", "NOI_KHOA_CO_XUONG_KHOP",
          "NOI_KHOA_THAN_KINH", "NOI_KHOA_TAM_THAN", "KET_QUA_KHAM_NGOAI_KHOA",
          "KET_QUA_KHAM_DA_LIEU", "BENH_KHAC_MAT", "BENH_KHAC_TAI_MUI_HONG",
          "HAM_TREN", "HAM_DUOI", "BENH_KHAC_RANG_HAM_MAT", "KET_QUA_KHAM_SAN_PHU_KHOA",
          "CAC_BENH_TAT_NEU_CO"
        ];
        const hasSpecificFinding = abnormalFindingKeys.some(key => {
          const value = String(p[key] ?? "").trim();
          return !!value && !isClearlyNormal(value) && !isNegativeOnly(value);
        });
        const overallConclusionIsNormal = isClearlyNormal(p["KET_LUAN_BENH"]);
        if (overallConclusionIsNormal && !hasSpecificFinding) {
          p["PHAN_LOAI_SK"] = "1";
        } else if (p["PHAN_LOAI_SK"] && String(p["PHAN_LOAI_SK"]).trim() !== "") {
          p["PHAN_LOAI_SK"] = normalizeClassification(p["PHAN_LOAI_SK"]);
        } else {
          // Không đoán phân loại chung khi có phát hiện hoặc thiếu kết luận rõ ràng.
          p["PHAN_LOAI_SK"] = "";
        }

        return p;
      });
    }

    return NextResponse.json({ patients: cleanedPatients });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}