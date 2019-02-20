import _ from 'lodash';
import { sanitize } from '../formats/link';
import Emitter from '../core/emitter';
import Quill from '../core/quill';
import { BlockEmbed } from '../blots/block';

const MAX_IMAGE_LENGTH = 3;

class ImageGrid extends BlockEmbed {
  constructor(scroll, domNode) {
    super(scroll, domNode);
    domNode.setAttribute('id', imageGridId());
  }

  static create(value) {
    const node = super.create();
    const { data } = value;
    node.setAttribute('image-grid-data', JSON.stringify(data));

    const cursor = document.createElement('div');
    cursor.classList.add('vertical-bar', 'cursor');
    node.appendChild(cursor);

    const guideline = document.createElement('div');
    guideline.classList.add('vertical-bar', 'guideline');
    node.appendChild(guideline);

    const dropHelperWrapper = document.createElement('div');
    dropHelperWrapper.classList.add('image-grid-drop-helper-wrapper');

    function showGuideline(index) {
      const { height } = node.querySelector('.ql-img img').getBoundingClientRect();
      let leftPosition = '';
      if (index === 0) {
        leftPosition = '-5px';
      } else {
        let sumOfWidths = -5;
        node.querySelectorAll('.ql-img').forEach((img, i) => {
          if (i < index) {
            sumOfWidths += img.getBoundingClientRect().width + 8;
          }
        });
        leftPosition = `${sumOfWidths}px`;
      }

      const guidelineElement = node.querySelector('.guideline');
      guidelineElement.style.left = leftPosition;
      guidelineElement.style.height = `${height}px`;
      guidelineElement.style.display = 'block';
    }

    function hideDropHelper() {
      const guidelineElement = node.querySelector('.guideline');
      guidelineElement.style.display = 'none';
      const dropHelperWrapperElement = node.querySelector('.image-grid-drop-helper-wrapper');
      dropHelperWrapperElement.style.display = 'none';
    }

    for (let i = 0; i <= data.length; i++) {
      const dropHelper = document.createElement('div');
      dropHelper.classList.add('image-grid-drop-helper');
      dropHelper.setAttribute('drop-index', i);
      dropHelper.addEventListener('dragenter', () => {
        showGuideline(i);
      });
      dropHelper.addEventListener('drop', () => {
        hideDropHelper();
      });
      dropHelperWrapper.appendChild(dropHelper);
    }
    dropHelperWrapper.addEventListener('dragleave', event => {
      if (
        event.fromElement &&
        !event.fromElement.classList.contains('image-grid-drop-helper')
      ) {
        hideDropHelper();
      }
    });

    node.appendChild(dropHelperWrapper);

    const imageGridItemWrapper = document.createElement('div');
    imageGridItemWrapper.classList.add('image-grid-item-wrapper');

    const sumOfRatios = data.reduce((accumulator, { attributes: { ratio } }) => accumulator + Number(ratio), 0);

    data.forEach((eachImageData, index) => {
      const {
        image: imageSrc,
        attributes: { ratio, caption, 'inline-comment': inlineComment },
      } = eachImageData;

      const imaegGridItemContainer = document.createElement('DIV');

      const imageElement = document.createElement('IMG');
      imageElement.setAttribute('src', this.sanitize(imageSrc));
      imageElement.setAttribute('caption', caption);

      const captionElement = document.createElement('input');
      captionElement.setAttribute('type', 'text');
      captionElement.setAttribute('maxlength', '40');
      captionElement.setAttribute('placeholder', 'Write a caption');
      captionElement.setAttribute('spellcheck', 'false');
      captionElement.classList.add('caption');
      captionElement.value = caption;
      captionElement.addEventListener('click', ev => {
        ev.stopPropagation();
      });
      captionElement.addEventListener('keydown', ev => {
        // Enter, Tab, Escape
        if (ev.keyCode === 13 || ev.keyCode === 9 || ev.keyCode === 27) {
          ev.preventDefault();
        } else {
          ev.stopPropagation();
        }
      });

      imaegGridItemContainer.style.width = `${(Number(ratio) * 100) / sumOfRatios}%`;
      imaegGridItemContainer.classList.add('image-grid-item-container', 'ql-img');
      if (inlineComment && inlineComment.length > 0) {
        inlineComment.forEach(commentId => {
          imaegGridItemContainer.classList.add(commentId);
        });
      }
      imaegGridItemContainer.appendChild(imageElement);
      imaegGridItemContainer.appendChild(captionElement);
      imaegGridItemContainer.setAttribute('item-index', index);
      imaegGridItemContainer.setAttribute('contenteditable', 'false');

      imageGridItemWrapper.appendChild(imaegGridItemContainer);
    });

    imageGridItemWrapper.firstElementChild.classList.add('left');
    imageGridItemWrapper.lastElementChild.classList.add('right');
    imageGridItemWrapper.setAttribute('contenteditable', 'false');
    node.appendChild(imageGridItemWrapper);

    node.setAttribute('contenteditable', 'false');
    return node;
  }

  static value(domNode) {
    const data = JSON.parse(domNode.getAttribute('image-grid-data'));
    const result = {
      data,
    };
    return result;
  }

  static sanitize(url) {
    return sanitize(url, ['http', 'https', 'data']) ? url : '//:0';
  }

  static getMaxLength() {
    return MAX_IMAGE_LENGTH;
  }

  showFakeCursor(index = 0) {
    const cursor = this.domNode.querySelector('.cursor');
    const { height } = this.domNode.querySelector('.ql-img img').getBoundingClientRect();
    cursor.style.height = `${height}px`;

    let leftPosition = '';
    if (index < 0) {
      leftPosition = `calc(100% + 5px)`;
    } else {
      let sumOfWidths = -5;
      this.domNode.querySelectorAll('.ql-img').forEach((img, i) => {
        if (i < index) {
          sumOfWidths += img.getBoundingClientRect().width + 8;
        }
      });
      leftPosition = `${sumOfWidths}px`;
    }

    cursor.style.left = leftPosition;
    cursor.style.height = `${height}px`;
    cursor.style.display = 'block';

    const maxCursorOffset = this.domNode.querySelectorAll('.ql-img').length;
    const cursorOffset = index < 0 ? maxCursorOffset : index;
    setTimeout(() => {
      this.scroll.domNode.blur(); // TODO: 이미지 focus된거 있으면 풀어주기
      this.scroll.emitter.once(Emitter.events.SELECTION_CHANGE, () => {
        this.hideFakeCursor();
      });
      this.scroll.emitter.emit(Emitter.events.IMAGE_GRID_FOCUS, {
        blot: this,
        cursorOffset,
        maxCursorOffset,
      });
    });
  }

  hideFakeCursor() {
    const cursor = this.domNode.querySelector('.cursor');
    cursor.style.display = 'none';
    this.scroll.emitter.emit(Emitter.events.IMAGE_GRID_FOCUS, undefined);
  }

  showDropHelper(isImageGridItemDragging) {
    if (
      !isImageGridItemDragging &&
      this.domNode.querySelectorAll('.image-grid-item-container').length === MAX_IMAGE_LENGTH
    ) {
      return;
    }

    const dropHelper = this.domNode.querySelector('.image-grid-drop-helper-wrapper');
    const { height } = this.domNode.querySelector('.ql-img img').getBoundingClientRect();
    dropHelper.style.height = `${height}px`;
    dropHelper.style.display = 'flex';
  }

  hideDropHelper() {
    const guideline = this.domNode.querySelector('.guideline');
    guideline.style.display = 'none';
    const dropHelper = this.domNode.querySelector('.image-grid-drop-helper-wrapper');
    dropHelper.style.display = 'none';
  }
}
ImageGrid.blotName = 'image-grid';
ImageGrid.className = 'image-grid';
ImageGrid.tagName = 'DIV';

function imageGridId() {
  const id = Math.random()
    .toString(36)
    .slice(2, 6);
  return `image-grid-${id}`;
}

export default ImageGrid;