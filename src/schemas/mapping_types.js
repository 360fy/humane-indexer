// jscs:disable requireCamelCaseOrUpperCaseIdentifiers
export const $Keyword = {
    type: 'text',
    analyzer: 'humane_keyword_analyzer'
};

export const $FacetKeyword = {
    type: 'text',
    analyzer: 'humane_keyword_analyzer',
    fielddata: true
};

export const $VernacularKeyword = {
    type: 'keyword',
    analyzer: 'humane_keyword_analyzer'
};

export const $Integer = {
    type: 'integer'
};

export const $NotIndexedInteger = {
    type: 'integer',
    index: false,
    include_in_all: false
};

export const $Short = {
    type: 'short'
};

export const $NotIndexedShort = {
    type: 'short',
    index: false,
    include_in_all: false
};

export const $Long = {
    type: 'long'
};

export const $NotIndexedLong = {
    type: 'long',
    index: false,
    include_in_all: false
};

export const $Double = {
    type: 'double'
};

export const $NotIndexedDouble = {
    type: 'double',
    index: false,
    include_in_all: false
};

export const $Boolean = {
    type: 'boolean'
};

export const $NotIndexedBoolean = {
    type: 'boolean',
    index: false,
    include_in_all: false
};

export const $Date = {
    type: 'date',
    format: 'yyyy-MM-dd HH:mm:ss||epoch_millis||yyyy-MM-dd\'T\'HH:mm:ss.SSS\'Z\''
};

export const $NotIndexedText = {
    type: 'keyword',
    index: false,
    include_in_all: false
};

export const $IdentityText = {
    type: 'keyword'
};

export const $Text = {
    type: 'text',
    analyzer: 'humane_standard_analyzer',
    fields: {
        raw: $IdentityText,

        humane: {
            type: 'text',
            analyzer: 'humane_text_analyzer'
        },
        shingle: {
            type: 'text',
            analyzer: 'humane_shingle_text_analyzer'
        }
    }
};

export const $DescriptiveText = {
    type: 'text',
    analyzer: 'humane_standard_analyzer',
    fields: {
        humane: {
            type: 'text',
            analyzer: 'humane_descriptive_text_analyzer'
        },
        shingle: {
            type: 'text',
            analyzer: 'humane_shingle_text_analyzer'
        }
    }
};

export const $VernacularText = {
    type: 'text',
    analyzer: 'humane_standard_analyzer',
    fields: {
        raw: $IdentityText,
        
        vernacular: {
            type: 'text',
            analyzer: 'humane_vernacular_analyzer'
        }
    }
};

export const $Geo = {
    type: 'geo_point'
};