<template>
  <a-input-number
    v-if="type === 'number'"
    :style="{ width: '80px' }"
    size="small"
    :default-value="(defaultValue as number)"
    @change="handleChange"
  />
  <a-select
    v-else-if="type === 'select'"
    :style="{ width: '120px' }"
    size="small"
    :model-value="defaultValue"
    @change="handleChange"
  >
    <a-option
      v-for="opt in options"
      :key="String(opt.value)"
      :value="opt.value"
    >
      {{ opt.label }}
    </a-option>
  </a-select>
  <a-switch
    v-else
    :default-checked="(defaultValue as boolean)"
    size="small"
    @change="handleChange"
  />
</template>

<script lang="ts" setup>
  import { PropType } from 'vue';

  const props = defineProps({
    type: {
      type: String,
      default: '',
    },
    name: {
      type: String,
      default: '',
    },
    defaultValue: {
      type: [String, Boolean, Number],
      default: '',
    },
    options: {
      type: Array as PropType<{ label: string; value: string | number }[]>,
      default: () => [],
    },
  });
  const emit = defineEmits(['inputChange']);
  const handleChange = (value: unknown) => {
    emit('inputChange', {
      value,
      key: props.name,
    });
  };
</script>
