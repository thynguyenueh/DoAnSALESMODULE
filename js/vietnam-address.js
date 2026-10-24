(function () {
    let unitsPromise;
    const previousRegionNames = {
        8: ['Hà Giang'],
        15: ['Yên Bái'],
        19: ['Bắc Kạn'],
        24: ['Bắc Giang'],
        25: ['Vĩnh Phúc', 'Hòa Bình'],
        31: ['Hải Dương'],
        33: ['Thái Bình'],
        37: ['Nam Định', 'Hà Nam'],
        44: ['Quảng Bình'],
        48: ['Quảng Nam'],
        51: ['Kon Tum'],
        52: ['Bình Định'],
        56: ['Ninh Thuận'],
        66: ['Phú Yên'],
        68: ['Đắk Nông', 'Bình Thuận'],
        75: ['Bình Phước'],
        79: ['TP.HCM', 'TP HCM', 'HCMC', 'Sài Gòn', 'Bình Dương', 'Bà Rịa-Vũng Tàu'],
        80: ['Long An'],
        82: ['Tiền Giang'],
        86: ['Bến Tre', 'Trà Vinh'],
        91: ['Kiên Giang'],
        92: ['Hậu Giang', 'Sóc Trăng'],
        96: ['Bạc Liêu']
    };

    function loadUnits() {
        if (!unitsPromise) {
            unitsPromise = fetch('js/vietnam-administrative-units.json')
                .then(response => {
                    if (!response.ok) throw new Error(`Không tải được danh sách địa giới hành chính (HTTP ${response.status}).`);
                    return response.json();
                })
                .then(units => {
                    if (!Array.isArray(units) || units.length !== 34 ||
                        units.some(province => !Array.isArray(province.wards) || province.wards.length === 0)) {
                        throw new Error('Danh sách địa giới hành chính không hợp lệ hoặc chưa đầy đủ.');
                    }
                    return units;
                });
        }
        return unitsPromise;
    }

    function setOptions(select, options, placeholder) {
        select.replaceChildren(new Option(placeholder, ''));
        options.forEach(option => select.add(new Option(option.name, String(option.code))));
    }

    function fillWardSelect(units, citySelect, wardSelect, selectedWard) {
        const province = units.find(item => String(item.code) === citySelect.value);
        setOptions(wardSelect, province ? province.wards : [], province ? 'Chọn phường / xã / đặc khu' : 'Chọn tỉnh / thành phố trước');
        wardSelect.disabled = !province;
        if (selectedWard != null) wardSelect.value = String(selectedWard);
    }

    function parseAddress(value, units) {
        const parts = String(value || '').split(',').map(part => part.trim()).filter(Boolean);
        let province;
        let ward;
        let provinceIndex = -1;
        let wardIndex = -1;
        for (let index = parts.length - 1; index >= 0 && !province; index--) {
            province = units.find(item => {
                const names = [item.name, item.name.replace(/^(Tỉnh|Thành phố)\s+/i, ''), ...(previousRegionNames[item.code] || [])];
                return names.some(name => normalize(name) === normalize(parts[index]));
            });
            if (province) provinceIndex = index;
        }
        if (province) {
            for (let index = provinceIndex - 1; index >= 0; index--) {
                ward = province.wards.find(item => normalize(item.name) === normalize(parts[index]));
                if (ward) {
                    wardIndex = index;
                    break;
                }
            }
        }
        const consumed = new Set([provinceIndex, wardIndex]);
        return {
            cityCode: province ? province.code : '',
            wardCode: ward ? ward.code : '',
            detail: parts.filter((_, index) => !consumed.has(index)).join(', ')
        };
    }

    function formatAddress(detail, citySelect, wardSelect) {
        return [
            String(detail || '').trim(),
            wardSelect.selectedOptions[0] && wardSelect.value ? wardSelect.selectedOptions[0].text : '',
            citySelect.selectedOptions[0] && citySelect.value ? citySelect.selectedOptions[0].text : ''
        ].filter(Boolean).join(', ');
    }

    function normalize(value) {
        return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLocaleLowerCase('vi').replace(/[.\s-]+/g, '');
    }

    function matchesCity(address, cityCode, units) {
        if (!cityCode) return true;
        const province = units.find(item => String(item.code) === String(cityCode));
        if (!province) return false;
        const aliases = [province.name.replace(/^(Tỉnh|Thành phố)\s+/i, ''), ...(previousRegionNames[province.code] || [])];
        const normalizedAddress = normalize(address);
        return aliases.some(alias => normalizedAddress.includes(normalize(alias)));
    }

    window.VietnamAddress = { loadUnits, setOptions, fillWardSelect, parseAddress, formatAddress, matchesCity };
})();
